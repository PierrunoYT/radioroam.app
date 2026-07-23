# Radio Roam

Radio Roam is a web-based live radio player with an iPod-inspired interface. It uses TuneIn/RadioTime to discover stations and resolve playable streams, while a lightweight Flask backend keeps external API requests and stream selection out of the browser.

## Features

- Search by station, city, show, artist, or genre
- Browse music, talk, sports, and nearby stations
- Play, pause, mute, adjust volume, and move between stations
- Fall back through multiple stream URLs when a station's first signal fails
- Save favorite stations in browser local storage
- Responsive interface with reduced-motion support

## Requirements

- Python 3.9 or newer
- An internet connection for TuneIn data, station artwork, live streams, and Google Fonts

## Getting started

Clone the repository and move into the project directory:

```bash
git clone <repository-url>
cd Radio.player
```

Create and activate a virtual environment:

```bash
python -m venv .venv
```

On Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

On macOS or Linux:

```bash
source .venv/bin/activate
```

Install the dependencies and start the development server:

```bash
python -m pip install -r requirements.txt
python app.py
```

Open [http://localhost:5000](http://localhost:5000) in a browser.

## Usage

Radio Roam loads music stations when it starts. Select a category or enter a search, then choose a station to begin playback. The click wheel controls playback, station navigation, search focus, and volume. Use the heart button to save the current station and the **Favorites** button to view saved stations.

Favorites remain in the current browser through `localStorage`; they are not synced to a user account.

## API

The Flask server exposes these endpoints to the frontend:

| Endpoint | Description |
| --- | --- |
| `GET /` | Render the player interface |
| `GET /api/search?q=<query>` | Search for radio stations |
| `GET /api/browse?category=<category>` | Browse `music`, `talk`, `sports`, or `local` stations |
| `GET /api/stream/<station_id>` | Resolve ordered stream candidates for a station |

API failures are returned as JSON with an `error` field. Invalid input returns `400`, unavailable streams return `404`, upstream failures return `502`, and upstream timeouts return `504`.

## Project structure

```text
Radio.player/
├── app.py                 # Flask routes and TuneIn/RadioTime client
├── requirements.txt       # Python dependencies
├── static/
│   ├── app.css            # Responsive player styling
│   └── app.js             # Search, playback, and favorites behavior
└── templates/
    └── index.html         # Main player page
```

## Notes

- Radio Roam relies on public TuneIn/RadioTime endpoints and does not require an API key. Changes or outages in that upstream service can affect the app.
- Stream availability and browser codec support vary by station. The app prioritizes HTTPS streams and common MP3, AAC, Ogg, and Opus formats, but some stations may still be unavailable.
- The built-in server runs with Flask debug mode enabled and is intended for local development, not production deployment.
