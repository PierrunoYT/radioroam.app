from __future__ import annotations

import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import quote, urlsplit

import requests
from flask import Flask, jsonify, render_template, request


class StationNotFound(LookupError):
    """Raised when Radio-Browser has no station with the requested ID."""


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
        # Broadcasters publish the same programme at several bitrates, and
        # Radio-Browser lists each as its own station, so the same name can
        # appear repeatedly. Leading with the quality makes those tellable
        # apart instead of looking like accidental duplicates.
        quality = " ".join(
            part for part in (
                f"{item['bitrate']}k" if item.get("bitrate") else "",
                (item.get("codec") or "").upper().replace("UNKNOWN", ""),
            ) if part
        )
        subtext = " · ".join(
            part for part in (quality, ", ".join(tags[:2]), location) if part
        )
        # Prefer url_resolved: `url` may point at a playlist the browser can't read.
        url = safe_remote_url(item.get("url_resolved") or item.get("url"))
        return {
            "id": item.get("stationuuid"),
            "name": (item.get("name") or "Unknown station").strip(),
            "subtext": subtext or "Live radio",
            "image": safe_remote_url(item.get("favicon")),
            "formats": item.get("codec") or None,
            "bitrate": item.get("bitrate") or None,
            "country": item.get("country") or None,
            "homepage": safe_remote_url(item.get("homepage")),
            "votes": item.get("votes") or 0,
            "url": url,
        }

    def _stations(self, path: str, params: dict[str, Any] | None = None) -> list[dict]:
        payload = self._get(path, params)
        return [self._station(item) for item in payload if item.get("stationuuid")]

    def search(self, query: str, limit: int = 200) -> list[dict]:
        # Radio-Browser's /search endpoint ANDs every field together, so a
        # plain name search misses stations that only match by country or
        # state (e.g. "Lucerne" or "Switzerland" won't surface Swiss stations
        # whose names don't contain those words). Query name/country/state
        # independently and merge. Unlike `name` and `state`, `country` is
        # matched case-sensitively against the stored country name, so it
        # needs the query title-cased ("switzerland" matches nothing, only
        # "Switzerland" does).
        per_field_limit = limit * 2
        field_queries = {"name": query, "country": query.title(), "state": query}
        merged: list[dict] = []
        seen: set[str] = set()
        for field, field_query in field_queries.items():
            for station in self._stations(
                "json/stations/search", {field: field_query, "limit": per_field_limit}
            ):
                if station["id"] in seen:
                    continue
                seen.add(station["id"])
                merged.append(station)
        merged.sort(key=lambda station: station["votes"], reverse=True)
        return merged[:limit]

    def by_tag(self, tag: str, limit: int = 60) -> list[dict]:
        return self._stations(f"json/stations/bytag/{quote(tag, safe='')}", {"limit": limit})

    def by_country_code(self, code: str, limit: int = 60) -> list[dict]:
        return self._stations(
            f"json/stations/bycountrycodeexact/{quote(code, safe='')}", {"limit": limit}
        )

    def get_stream_candidates(self, station_uuid: str) -> list[str]:
        """Resolve a station's current stream URL(s) and register the play.

        Radio-Browser ranks stations by click count, so this endpoint is both
        how you get a fresh URL and how you vote for the station. The URL it
        returns sometimes points at a playlist file rather than raw audio, so
        unwrap that into the direct stream(s) it lists.
        """
        data = self._get(f"json/url/{quote(station_uuid, safe='')}")
        if str(data.get("ok")).lower() != "true":
            return []
        url = safe_remote_url(data.get("url"))
        return resolve_stream_candidates(url) if url else []


def safe_remote_url(value: Any) -> str | None:
    """Return only absolute HTTP(S) URLs supplied by station operators."""
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    return value.strip()


# `.pls`/`.m3u` playlists point at a stream rather than being one, which a
# plain <audio> element can't play. `.m3u8` is ambiguous: it is also the
# extension HLS uses for its (playable, adaptive-bitrate) manifests, which
# must be left untouched for the client's HLS support to load.
PLAYLIST_SUFFIXES = (".pls", ".m3u", ".m3u8")
MAX_PLAYLIST_BYTES = 64 * 1024
HLS_MANIFEST_MARKERS = (
    "#EXT-X-STREAM-INF",
    "#EXT-X-TARGETDURATION",
    "#EXT-X-MEDIA-SEQUENCE",
    "#EXT-X-KEY",
)


def _playlist_suffix(url: str) -> str | None:
    path = urlsplit(url).path.lower()
    return next((suffix for suffix in PLAYLIST_SUFFIXES if path.endswith(suffix)), None)


def _fetch_playlist_text(url: str) -> str | None:
    try:
        with requests.get(url, timeout=5, stream=True) as response:
            response.raise_for_status()
            body = bytearray()
            for chunk in response.iter_content(chunk_size=4096):
                body.extend(chunk)
                if len(body) >= MAX_PLAYLIST_BYTES:
                    break
        return bytes(body).decode("utf-8", errors="ignore")
    except requests.RequestException:
        return None


def _parse_pls_entries(text: str) -> list[str]:
    return [entry.strip() for entry in re.findall(r"(?im)^File\d+\s*=\s*(.+)$", text)]


def _parse_m3u_entries(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def resolve_stream_candidates(url: str, depth: int = 0) -> list[str]:
    """Unwrap a `.pls`/`.m3u` playlist into the direct stream(s) it lists."""
    suffix = _playlist_suffix(url)
    if depth >= 2 or not suffix:
        return [url]

    text = _fetch_playlist_text(url)
    if text is None:
        return [url]
    if suffix == ".m3u8" and any(marker in text for marker in HLS_MANIFEST_MARKERS):
        return [url]

    entries = _parse_pls_entries(text) if suffix == ".pls" else _parse_m3u_entries(text)
    resolved: list[str] = []
    for entry in entries:
        candidate = safe_remote_url(entry)
        if not candidate:
            continue
        for nested in resolve_stream_candidates(candidate, depth + 1):
            if nested not in resolved:
                resolved.append(nested)
    return resolved or [url]


class TTLCache:
    """Tiny time-boxed cache so repeated browsing doesn't hammer the API."""

    def __init__(self, ttl: int = 600, max_entries: int = 512) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._entries: dict[Any, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get_or_set(self, key: Any, produce):
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry and now - entry[0] < self.ttl:
                return entry[1]
            if entry:
                del self._entries[key]
        value = produce()
        # Don't cache an empty result. Radio-Browser occasionally answers a tag
        # query with nothing, and storing that would leave a category looking
        # broken for the full TTL rather than for one request.
        if value:
            with self._lock:
                if key not in self._entries and len(self._entries) >= self.max_entries:
                    del self._entries[next(iter(self._entries))]
                self._entries[key] = (now, value)
        return value


class FixedWindowRateLimiter:
    """Small per-process guard; production proxies should enforce this globally too."""

    def __init__(self, max_entries: int = 4096) -> None:
        self.max_entries = max_entries
        self._entries: dict[tuple[str, str], tuple[float, int]] = {}
        self._lock = threading.Lock()

    def check(self, scope: str, client: str, limit: int, window: int = 60) -> int | None:
        now = time.monotonic()
        key = (scope, client)
        with self._lock:
            started_at, count = self._entries.get(key, (now, 0))
            if now - started_at >= window:
                started_at, count = now, 0
            count += 1
            if key not in self._entries and len(self._entries) >= self.max_entries:
                del self._entries[next(iter(self._entries))]
            self._entries[key] = (started_at, count)
        if count <= limit:
            return None
        return max(1, int(window - (now - started_at)) + 1)


app = Flask(__name__)
radio = RadioBrowserAPI()
browse_cache = TTLCache(ttl=600)
search_cache = TTLCache(ttl=60)
stream_cache = TTLCache(ttl=30)
rate_limiter = FixedWindowRateLimiter()

SEARCH_QUERY_MAX_LENGTH = 100
STATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,64}$")

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; img-src 'self' data: https:; "
        "media-src https: http: blob:; connect-src 'self' https: http:; object-src 'none'; "
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    ),
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}

# Each category maps to the Radio-Browser tags that best represent it. Results
# for every tag are interleaved so a category isn't dominated by one genre.
CATEGORY_TAGS = {
    "music": ["pop", "rock", "jazz", "electronic", "classical", "hip hop"],
    "talk": ["talk", "news", "public radio", "comedy"],
    "sports": ["sports", "football", "basketball"],
}


@app.after_request
def add_security_headers(response):
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


def rate_limit(scope: str, limit: int):
    retry_after = rate_limiter.check(scope, request.remote_addr or "unknown", limit)
    if retry_after is None:
        return None
    response = jsonify({"error": "Too many requests. Please try again shortly."})
    response.status_code = 429
    response.headers["Retry-After"] = str(retry_after)
    return response


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
    limited = rate_limit("search", 30)
    if limited:
        return limited

    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Enter a station, show, or genre."}), 400
    if len(query) > SEARCH_QUERY_MAX_LENGTH:
        return jsonify({"error": "Searches must be 100 characters or fewer."}), 400
    return api_response(lambda: search_cache.get_or_set(query.casefold(), lambda: radio.search(query)))


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
    return merged


@app.get("/api/browse")
def browse():
    limited = rate_limit("browse", 60)
    if limited:
        return limited

    category = request.args.get("category", "music").lower()
    if category not in {"music", "talk", "sports", "local"}:
        return jsonify({"error": "Unknown category."}), 400
    # "Local" varies per listener, so it's keyed by the country we inferred.
    key = (category, listener_country_code() if category == "local" else None)
    response = api_response(lambda: browse_cache.get_or_set(key, lambda: browse_category(category)))
    if category == "local":
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Accept-Language"
    return response


@app.get("/api/stream/<station_id>")
def stream(station_id: str):
    limited = rate_limit("stream", 20)
    if limited:
        return limited

    if not STATION_ID_PATTERN.fullmatch(station_id):
        return jsonify({"error": "Invalid station ID."}), 400

    def resolve_streams():
        urls = stream_cache.get_or_set(station_id, lambda: radio.get_stream_candidates(station_id))
        return {"url": urls[0] if urls else None, "urls": urls}

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
    debug = os.getenv("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    app.run(debug=debug, port=5000)
