# Radio Roam

Radio Roam is a web-based live radio player with an iPod-inspired interface. It uses the [Radio-Browser](https://www.radio-browser.info/) community directory to discover stations and resolve playable streams, while Cloudflare Pages Functions keep external API requests and stream selection out of the browser.

## Features

- Search by station, city, show, artist, or genre
- Browse music, talk, sports, and nearby stations
- Play, pause, mute, adjust volume, and move between stations
- Fall back through multiple stream URLs when a station's first signal fails
- Resolve `.pls`/`.m3u` playlist URLs into their direct streams server-side, and play `.m3u8` HLS streams client-side via [hls.js](https://github.com/video-dev/hls.js) where the browser lacks native support
- Save favorite stations in browser local storage
- Responsive interface with reduced-motion support

## Requirements

- Node.js and npm (for the Wrangler CLI)
- An internet connection for Radio-Browser data, station artwork, live streams, and Google Fonts

## Getting started

```bash
git clone https://github.com/PierrunoYT/radioroam.app.git
cd radioroam.app
npm install
npm run dev
```

Open the local URL Wrangler prints (usually [http://localhost:8788](http://localhost:8788)).

## Station data

All station data comes from the [Radio-Browser](https://www.radio-browser.info/)
API at request time — there is nothing to download, build, or keep in sync. No
API key is required.

| Endpoint used | Purpose |
| --- | --- |
| `/json/stations/search` | Search by station name |
| `/json/stations/bytag/<tag>` | Genre listings behind the category buttons |
| `/json/stations/bycountrycodeexact/<code>` | The **Near me** category |
| `/json/url/<uuid>` | Resolve a station's current stream URL |

Requests go to the `all.api.radio-browser.info` round-robin address, falling back
to a named mirror if that hands out a host that is down. Results are requested
with `hidebroken=true` so stations failing Radio-Browser's health checks are
excluded, and ordered by `clickcount` so well-known stations surface first.

`/json/url/<uuid>` both returns the current URL and registers the play, which is
how Radio-Browser ranks stations — so resolving a stream also votes for it.

## Usage

Radio Roam loads music stations when it starts. Select a category or enter a search, then choose a station to begin playback. The click wheel controls playback, station navigation, search focus, and volume. Use the heart button to save the current station and the **Favorites** button to view saved stations.

Favorites remain in the current browser through `localStorage`; they are not synced to a user account.

## API

The Pages Functions expose these endpoints to the frontend:

| Endpoint | Description |
| --- | --- |
| `GET /` | Serve the player interface |
| `GET /api/search?q=<query>` | Search for radio stations |
| `GET /api/browse?category=<category>` | Browse `music`, `talk`, `sports`, or `local` stations |
| `GET /api/stream/<station_id>` | Resolve ordered stream candidates for a station |

API failures are returned as JSON with an `error` field. Invalid input returns `400`, unknown or unplayable stations return `404`, upstream failures return `502`, and upstream timeouts return `504`.

## Project structure

```text
radioroam.app/
├── public/                 # Cloudflare Pages build output
│   ├── index.html          # Main player page
│   ├── privacy.html, terms.html, 404.html
│   ├── _headers            # CSP and security headers
│   └── static/
│       ├── app.css         # Responsive player styling
│       ├── app.js          # Search, playback, and favorites behavior
│       └── vendor/hls.light.min.js  # hls.js, loaded on demand for HLS-only stations
└── functions/              # Cloudflare Pages Functions
    ├── _lib/radio-browser.js
    └── api/
        ├── search.js
        ├── browse.js
        └── stream/[station_id].js
```

## Deploying to Cloudflare Pages

`public/` holds the static site and `functions/api/*` implements the three
JSON endpoints as Pages Functions.

When connecting the GitHub repo in the Cloudflare dashboard's "Set up builds
and deployments" screen, use:

| Setting | Value |
| --- | --- |
| Framework preset | `None` |
| Build command | *(leave empty)* |
| Build output directory | `public` |
| Root directory | *(leave default)* |

No build step is needed — the output directory is already checked into the
repo. Cloudflare automatically picks up the `functions/` folder at the repo
root and serves `/api/search`, `/api/browse`, and `/api/stream/<id>` from it.

Pages serves `privacy.html` at `/privacy` on its own and 308-redirects the
`.html` URL to the extensionless one, so no `_redirects` rules are needed for
those pages — adding a `/privacy /privacy.html 200` rewrite makes the two
rules fight each other and produces a redirect loop. `public/404.html` is
picked up automatically for unmatched paths, and `public/_headers` sets the
CSP and related security headers.

## Notes

- Radio Roam relies on the public Radio-Browser API and does not require an API key. Changes or outages in that upstream service can affect the app.
- Category listings are cached in memory for ten minutes, so repeated browsing does not re-query the API.
- **Near me** infers the listener's country from the `Accept-Language` header, since Radio-Browser has no geo-targeted feed. It is a rough guess, and returns nothing when the browser sends no region subtag.
- Stream availability and browser codec support vary by station. The app prioritizes HTTPS streams and common MP3, AAC, Ogg, and Opus formats, but some stations may still be unavailable.
- `/api/stream/<id>` unwraps `.pls`/`.m3u` playlists into the stream URL(s) they list before returning them, since a browser can't play a playlist file directly. `.m3u8` is left alone when it looks like a genuine HLS manifest, since that one **is** playable — the client loads `static/vendor/hls.light.min.js` on demand for browsers without native HLS support (Safari has native support and skips it).
- The application applies best-effort per-isolate API limits. Cloudflare deployments should also configure platform rate-limiting rules for globally consistent enforcement across Functions isolates.
