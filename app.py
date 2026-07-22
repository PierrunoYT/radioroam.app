from __future__ import annotations

from typing import Any

import requests
from flask import Flask, jsonify, render_template, request


class TuneInAPI:
    """Small wrapper around the public TuneIn / RadioTime endpoints."""

    BASE_URL = "https://opml.radiotime.com"

    def __init__(self, partner_id: str = "RadioTime") -> None:
        self.partner_id = partner_id
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        )

    def _request(self, endpoint: str, params: dict[str, Any] | None = None) -> dict:
        query = {**(params or {}), "render": "json", "partnerId": self.partner_id}
        response = self.session.get(
            f"{self.BASE_URL}/{endpoint.lstrip('/')}", params=query, timeout=12
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _outlines(items: list[dict]) -> list[dict]:
        outlines: list[dict] = []
        for item in items:
            if item.get("element") != "outline":
                continue
            children = item.get("children")
            if children:
                outlines.extend(TuneInAPI._outlines(children))
            else:
                outlines.append(item)
        return outlines

    @staticmethod
    def _station(item: dict) -> dict:
        image = item.get("image")
        if image and image.startswith("http://"):
            image = f"https://{image.removeprefix('http://')}"
        return {
            "id": item.get("guide_id"),
            "name": item.get("text") or "Unknown station",
            "subtext": item.get("subtext") or item.get("genre") or "Live radio",
            "image": image,
            "formats": item.get("formats"),
            "bitrate": item.get("bitrate"),
            "url": item.get("URL") or item.get("url"),
        }

    def search(self, query: str) -> list[dict]:
        data = self._request("Search.ashx", {"query": query})
        return [
            self._station(item)
            for item in self._outlines(data.get("body", []))
            if item.get("type") == "audio"
        ]

    def browse(self, category: str = "music") -> list[dict]:
        # TuneIn's broad category pages contain navigation links rather than
        # stations. Search provides the playable station mix users expect,
        # while the local category is already a geo-targeted station listing.
        if category != "local":
            return self.search(f"{category} radio")
        data = self._request("Browse.ashx", {"c": "local"})
        return [
            self._station(item)
            for item in self._outlines(data.get("body", []))
            if item.get("type") == "audio"
        ]

    def get_stream_urls(self, station_id: str) -> list[str]:
        station_id = station_id if station_id.startswith("s") else f"s{station_id}"
        data = self._request("Tune.ashx", {"id": station_id})
        supported = {"mp3": 0, "aac": 1, "aacp": 1, "ogg": 2, "opus": 2}
        streams = []
        for item in data.get("body", []):
            stream_url = item.get("url") or item.get("URL")
            media_type = str(item.get("media_type", "")).lower()
            if stream_url and media_type in supported:
                streams.append(
                    (
                        not stream_url.startswith("https://"),
                        supported[media_type],
                        -int(item.get("reliability") or 0),
                        -int(item.get("bitrate") or 0),
                        stream_url,
                    )
                )
        return list(dict.fromkeys(stream[-1] for stream in sorted(streams)))

    def get_stream_url(self, station_id: str) -> str | None:
        streams = self.get_stream_urls(station_id)
        return streams[0] if streams else None


app = Flask(__name__)
tunein = TuneInAPI()


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Enter a station, show, or genre."}), 400
    return api_response(lambda: tunein.search(query))


@app.get("/api/browse")
def browse():
    category = request.args.get("category", "music").lower()
    if category not in {"music", "talk", "sports", "local"}:
        return jsonify({"error": "Unknown category."}), 400
    return api_response(lambda: tunein.browse(category))


@app.get("/api/stream/<station_id>")
def stream(station_id: str):
    def resolve_streams():
        urls = tunein.get_stream_urls(station_id)
        return {"url": urls[0] if urls else None, "urls": urls}

    return api_response(resolve_streams)


def api_response(action):
    try:
        result = action()
        if isinstance(result, dict) and not result.get("url"):
            return jsonify({"error": "No playable stream was found."}), 404
        return jsonify(result)
    except requests.Timeout:
        return jsonify({"error": "TuneIn took too long to respond."}), 504
    except (requests.RequestException, ValueError):
        return jsonify({"error": "TuneIn is unavailable right now."}), 502


if __name__ == "__main__":
    app.run(debug=True, port=5000)
