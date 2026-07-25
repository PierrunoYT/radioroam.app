from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlsplit

import requests
from flask import Flask, jsonify, render_template, request


class StationNotFound(LookupError):
    """Raised when Radio-Browser has no station with the requested ID."""


# Suffixes where the registrable domain is three labels deep, so "bbc.co.uk"
# isn't mistaken for the far too broad "co.uk".
MULTI_LABEL_SUFFIXES = frozenset({
    "co.uk", "org.uk", "ac.uk", "gov.uk", "co.nz", "co.za", "co.jp", "co.kr",
    "co.in", "com.au", "net.au", "org.au", "com.br", "com.ar", "com.mx",
    "com.tr", "com.pl", "com.ua", "com.cn", "com.tw", "com.hk", "com.sg",
})


def registrable_domain(url: str | None) -> str | None:
    """Reduce a URL to the domain its owner registered ('audio.jam.fm' -> 'jam.fm')."""
    if not url:
        return None
    host = urlsplit(url if "//" in url else f"//{url}").netloc.lower().split(":")[0]
    labels = [label for label in host.split(".") if label]
    if len(labels) < 2:
        return None
    domain = ".".join(labels[-2:])
    if domain in MULTI_LABEL_SUFFIXES and len(labels) >= 3:
        return ".".join(labels[-3:])
    return domain


# Bracketed quality tags: "(AAC 192)", "(128k)", "[aac]", "(MP3)".
QUALITY_TAG = re.compile(
    r"[(\[]\s*(?:aac\+?p?|mp3|ogg|opus|flac|hls|hd|sd|stereo"
    r"|\d{2,3}\s*k?(?:bps)?|[\s,.\-x/])+\s*[)\]]",
    re.IGNORECASE,
)

# "Radio" is decoration rather than identity: the same station is listed as
# "SRF 3", "Radio SRF 3" and "SRF1 Radio".
STATION_WORD = re.compile(r"\b(?:radio|rádio|radyo)\b", re.IGNORECASE)


def normalize_name(name: str) -> str:
    """Reduce a station name to the part that actually identifies it.

    Broadcasters label the same stream inconsistently - "SRF 3", "Radio SRF 3"
    and "Radio SRF 3 (AAC 192)" are one station - so the quality tag and the
    word "radio" are dropped before comparing. Only the tags listed above are
    stripped: a parenthetical like "(El Centro)" or "(Top 40 & Pop Music)"
    distinguishes real stations and has to survive.

    Names that are *only* decoration ("Radio", "(128k)") would collapse to an
    empty string and swallow each other, so those keep their full name.
    """
    stripped = STATION_WORD.sub(" ", QUALITY_TAG.sub(" ", name or ""))
    reduced = re.sub(r"\W+", "", stripped.casefold(), flags=re.UNICODE)
    return reduced or re.sub(r"\W+", "", (name or "").casefold(), flags=re.UNICODE)


def deduplicate(stations: list[dict]) -> list[dict]:
    """Collapse the bitrate variants Radio-Browser lists as separate stations.

    A stream submitted at several bitrates becomes several entries - searching
    "srf" returns Radio SRF 3 three times, at 48, 64 and 88 kbps. Grouping on
    name alone would be far too aggressive, since plenty of unrelated stations
    share generic names, so a group also has to agree on the operator's domain,
    taken from the homepage where there is one and the stream host otherwise.

    The highest-bitrate entry wins, and any artwork or homepage its siblings
    have is copied over - the best-sounding variant is often the one missing a
    favicon.
    """
    by_name: dict[str, list[dict]] = {}
    for station in stations:
        by_name.setdefault(normalize_name(station["name"]), []).append(station)

    groups: list[list[dict]] = []
    for named in by_name.values():
        # Within one name, cluster by any shared domain. Checking homepage and
        # stream host together matters because a station's variants often carry
        # the homepage inconsistently - one entry has it, its twin doesn't.
        clusters: list[tuple[set[str], list[dict]]] = []
        for station in named:
            domains = {
                registrable_domain(station.get("homepage")),
                registrable_domain(station.get("url")),
            }
            domains.discard(None)
            match = next((c for c in clusters if c[0] & domains), None)
            if match is None:
                clusters.append((domains, [station]))
            else:
                match[0].update(domains)
                match[1].append(station)
        groups.extend(members for _, members in clusters)

    merged = []
    for members in groups:
        best = max(members, key=lambda s: (s.get("bitrate") or 0, s.get("votes") or 0))
        # The highest-bitrate entry is often the one labelled "(AAC 192)", an
        # encoding detail rather than a name. Label the group from its most
        # voted member instead, since that is the entry listeners actually
        # recognise ("BBC Radio 2" over the same station filed as "bbc 2"),
        # and drop any quality tag so the label can't advertise a bitrate
        # different from the stream being played.
        label = max(members, key=lambda m: (m.get("votes") or 0, -len(m["name"])))
        cleaned = re.sub(r"\s{2,}", " ", QUALITY_TAG.sub(" ", label["name"])).strip()
        best["name"] = cleaned or label["name"].strip()
        if not best.get("image"):
            best["image"] = next((m["image"] for m in members if m.get("image")), None)
        if not best.get("homepage"):
            best["homepage"] = next((m["homepage"] for m in members if m.get("homepage")), None)
        merged.append(best)
    return merged


class RadioBrowserAPI:
    """Client for the Radio-Browser directory API.

    Radio-Browser is a community-maintained, openly licensed directory of
    around 50k stations. Everything the player needs comes from it: search,
    genre browsing, country listings, and live stream-URL resolution.
    """

    # Round-robin DNS across the community mirrors, with a named server as a
    # fallback for the case where the rotation hands out a host that's down.
    HOSTS = ("https://all.api.radio-browser.info", "https://de1.api.radio-browser.info")

    # Stations whose stream last failed a health check are excluded everywhere.
    DEFAULTS = {"hidebroken": "true", "order": "clickcount", "reverse": "true"}

    def __init__(self, timeout: int = 10) -> None:
        self.timeout = timeout
        self.session = requests.Session()
        # Radio-Browser asks clients to identify themselves so they can spot
        # misbehaving traffic rather than blanket-rate-limiting everyone.
        self.session.headers.update({"User-Agent": "RadioRoam/1.0"})

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        query = {**self.DEFAULTS, **(params or {})}
        last_error: Exception = RuntimeError("no hosts configured")
        for host in self.HOSTS:
            try:
                response = self.session.get(
                    f"{host}/{path.lstrip('/')}", params=query, timeout=self.timeout
                )
                # A 404 is a definitive answer about the station, not a sick
                # mirror, so don't waste a retry on the next host.
                if response.status_code == 404:
                    raise StationNotFound(path)
                response.raise_for_status()
                return response.json()
            except (requests.RequestException, ValueError) as error:
                last_error = error
        raise last_error

    @staticmethod
    def _station(item: dict) -> dict:
        tags = [tag.strip() for tag in (item.get("tags") or "").split(",") if tag.strip()]
        location = item.get("state") or item.get("country")
        subtext = " · ".join(part for part in (", ".join(tags[:2]), location) if part)
        # Prefer url_resolved: `url` may point at a playlist the browser can't read.
        url = item.get("url_resolved") or item.get("url")
        return {
            "id": item.get("stationuuid"),
            "name": (item.get("name") or "Unknown station").strip(),
            "subtext": subtext or "Live radio",
            "image": item.get("favicon") or None,
            "formats": item.get("codec") or None,
            "bitrate": item.get("bitrate") or None,
            "country": item.get("country") or None,
            "homepage": item.get("homepage") or None,
            "votes": item.get("votes") or 0,
            "url": url,
        }

    def _stations(self, path: str, params: dict[str, Any] | None = None) -> list[dict]:
        payload = self._get(path, params)
        stations = [self._station(item) for item in payload if item.get("stationuuid")]
        # Radio-Browser is ordered by popularity; grouping preserves the order
        # each station was first seen in, so the ranking survives.
        return deduplicate(stations)

    def search(self, query: str, limit: int = 60) -> list[dict]:
        return self._stations(
            "json/stations/search", {"name": query, "limit": limit}
        )

    def by_tag(self, tag: str, limit: int = 60) -> list[dict]:
        return self._stations(f"json/stations/bytag/{tag}", {"limit": limit})

    def by_country_code(self, code: str, limit: int = 60) -> list[dict]:
        return self._stations(
            f"json/stations/bycountrycodeexact/{code}", {"limit": limit}
        )

    def get_stream_url(self, station_uuid: str) -> str | None:
        """Resolve a station's current stream URL and register the play.

        Radio-Browser ranks stations by click count, so this endpoint is both
        how you get a fresh URL and how you vote for the station.
        """
        data = self._get(f"json/url/{station_uuid}")
        return data.get("url") if str(data.get("ok")).lower() == "true" else None


class TTLCache:
    """Tiny time-boxed cache so repeated browsing doesn't hammer the API."""

    def __init__(self, ttl: int = 600) -> None:
        self.ttl = ttl
        self._entries: dict[Any, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get_or_set(self, key: Any, produce):
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry and now - entry[0] < self.ttl:
                return entry[1]
        value = produce()
        with self._lock:
            self._entries[key] = (now, value)
        return value


app = Flask(__name__)
radio = RadioBrowserAPI()
browse_cache = TTLCache(ttl=600)

# Each category maps to the Radio-Browser tags that best represent it. Results
# for every tag are interleaved so a category isn't dominated by one genre.
CATEGORY_TAGS = {
    "music": ["pop", "rock", "jazz", "electronic", "classical", "hip hop"],
    "talk": ["talk", "news", "public radio", "comedy"],
    "sports": ["sports", "football", "basketball"],
}


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/privacy")
def privacy():
    return render_template("legal.html", page="privacy")


@app.get("/terms")
def terms():
    return render_template("legal.html", page="terms")


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Enter a station, show, or genre."}), 400
    return api_response(lambda: radio.search(query))


def listener_country_code() -> str | None:
    """Guess the listener's country from the browser's Accept-Language header.

    Radio-Browser has no geo-targeted feed, and the server's own IP address is
    useless once the app is deployed - it would report the datacenter. The
    region subtag of the browser locale ("de-CH" -> CH) is imperfect but it at
    least describes the listener rather than the host.
    """
    for language in request.accept_languages.values():
        parts = language.replace("_", "-").split("-")
        if len(parts) > 1 and len(parts[-1]) == 2 and parts[-1].isalpha():
            return parts[-1].upper()
    return None


def browse_category(category: str) -> list[dict]:
    if category == "local":
        code = listener_country_code()
        if not code:
            return []
        return radio.by_country_code(code)

    tags = CATEGORY_TAGS[category]
    # One request per tag, run concurrently - done in sequence this is the
    # slowest thing the app does.
    with ThreadPoolExecutor(max_workers=len(tags)) as pool:
        buckets = list(pool.map(lambda tag: radio.by_tag(tag, limit=15), tags))
    merged: list[dict] = []
    seen: set[str] = set()
    # Round-robin the per-tag results so the list stays varied.
    for index in range(max((len(b) for b in buckets), default=0)):
        for bucket in buckets:
            if index >= len(bucket) or bucket[index]["id"] in seen:
                continue
            seen.add(bucket[index]["id"])
            merged.append(bucket[index])
    # Each tag query was deduplicated on its own, but a station can appear
    # under several tags as different bitrate variants, so collapse again
    # across the combined list.
    return deduplicate(merged)


@app.get("/api/browse")
def browse():
    category = request.args.get("category", "music").lower()
    if category not in {"music", "talk", "sports", "local"}:
        return jsonify({"error": "Unknown category."}), 400
    # "Local" varies per listener, so it's keyed by the country we inferred.
    key = (category, listener_country_code() if category == "local" else None)
    return api_response(lambda: browse_cache.get_or_set(key, lambda: browse_category(category)))


@app.get("/api/stream/<station_id>")
def stream(station_id: str):
    def resolve_streams():
        url = radio.get_stream_url(station_id)
        return {"url": url, "urls": [url] if url else []}

    return api_response(resolve_streams)


def api_response(action):
    try:
        result = action()
        if isinstance(result, dict) and not result.get("url"):
            return jsonify({"error": "No playable stream was found."}), 404
        return jsonify(result)
    except StationNotFound:
        return jsonify({"error": "That station is no longer listed."}), 404
    except requests.Timeout:
        return jsonify({"error": "Radio-Browser took too long to respond."}), 504
    except (requests.RequestException, ValueError):
        return jsonify({"error": "Radio-Browser is unavailable right now."}), 502


if __name__ == "__main__":
    app.run(debug=True, port=5000)
