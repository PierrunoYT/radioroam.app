# Changelog

All notable changes to Radio Roam, grouped by day. Written from the git history.

## 2026-07-30

- Fixed HLS `.m3u8` streams playing in the browser: resolved `.pls`/`.m3u` playlist
  URLs server-side (Flask and Cloudflare Pages Functions) into the direct stream(s)
  they list, and added client-side HLS playback via `hls.js` (loaded on demand for
  browsers without native support). Updated the CSP to allow `blob:` media and
  `http(s)` connections for this.
- Broadened search to also match by country and state, not just station name, so
  queries like "Lucerne" or "Switzerland" return regional stations instead of only
  ones with that word in their name.
- Fixed the mobile player overflowing/zooming incorrectly: prevented zoom overflow,
  kept the layout stable when the page is zoomed, fixed player scaling on narrow
  screens, and made several general mobile responsiveness improvements.

## 2026-07-27

- Ported the Flask app to a static build for Cloudflare Pages, with a Functions API
  (`functions/api/*`, `functions/_lib/radio-browser.js`) mirroring the Flask
  `RadioBrowserAPI` client so both deployments serve the same data shape.
- Hardened station metadata and API endpoints: added stricter validation/sanitizing
  across `app.py` and the Functions equivalents, plus new security headers
  (`public/_headers`).
- Removed dead footer links from both the Flask templates and the Pages build.
- Fixed a redirect loop on `/privacy` and `/terms`, and added a custom 404 page.

## 2026-07-25

- Replaced the TuneIn integration with the Radio-Browser API as the station data
  source, rewriting most of `app.py`'s station-fetching logic.
- Collapsed duplicate bitrate variants of the same station into one entry, and gave
  stations without artwork a fallback tile.
- Improved station name matching to look past quality/bitrate tags and the generic
  word "radio".
- Reverted the bitrate-collapsing change shortly after, restoring every stream
  variant as its own listed station.
- Added a `.code_index` database file for local code indexing tooling.

## 2026-07-23

- Added the project README.
- Added a persistent dark mode toggle (saved across sessions).
- Added a responsive site footer.
- Added `/privacy` and `/terms` legal pages.

## 2026-07-22

- Initial commit: built the iPod-inspired live radio player (Flask app, station
  search/browse, playback, favorites).
- Fixed playback for stations proxied through TuneIn.
- Rebranded the app as "Radio Roam".
