// Client for the Radio-Browser directory API, ported from the Flask app's
// RadioBrowserAPI so the Pages Functions serve the same shape of data.

const HOSTS = ['https://all.api.radio-browser.info', 'https://de1.api.radio-browser.info'];
const DEFAULTS = { hidebroken: 'true', order: 'clickcount', reverse: 'true' };
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_CACHE_ENTRIES = 512;
const MAX_RATE_LIMIT_ENTRIES = 4096;
const cache = new Map();
const rateLimits = new Map();

export class StationNotFound extends Error {}

async function get(path, params = {}) {
  const query = new URLSearchParams({ ...DEFAULTS, ...params });
  let lastError = new Error('no hosts configured');
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}/${path.replace(/^\//, '')}?${query}`, {
        headers: { 'User-Agent': 'RadioRoam/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // A 404 is a definitive answer about the station, not a sick mirror,
      // so don't waste a retry on the next host.
      if (response.status === 404) throw new StationNotFound(path);
      if (!response.ok) throw new Error(`Radio-Browser responded ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof StationNotFound) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function toStation(item) {
  const tags = (item.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  const location = item.state || item.country;
  // Broadcasters publish the same programme at several bitrates, and
  // Radio-Browser lists each as its own station, so the same name can appear
  // repeatedly. Leading with the quality makes those tellable apart instead
  // of looking like accidental duplicates.
  const quality = [
    item.bitrate ? `${item.bitrate}k` : '',
    (item.codec || '').toUpperCase().replace('UNKNOWN', ''),
  ].filter(Boolean).join(' ');
  const subtext = [quality, tags.slice(0, 2).join(', '), location].filter(Boolean).join(' · ');
  // Prefer url_resolved: `url` may point at a playlist the browser can't read.
  const url = safeRemoteUrl(item.url_resolved || item.url);
  return {
    id: item.stationuuid,
    name: (item.name || 'Unknown station').trim(),
    subtext: subtext || 'Live radio',
    image: safeRemoteUrl(item.favicon),
    formats: item.codec || null,
    bitrate: item.bitrate || null,
    country: item.country || null,
    homepage: safeRemoteUrl(item.homepage),
    votes: item.votes || 0,
    url,
  };
}

async function stations(path, params) {
  const payload = await get(path, params);
  return payload.filter(item => item.stationuuid).map(toStation);
}

// Unlike `name` and `state`, Radio-Browser's `country` search param is
// case-sensitive against the stored country name (e.g. "switzerland" matches
// nothing, only "Switzerland" does), so title-case the query before using it.
function titleCase(value) {
  return value.toLowerCase().replace(/(^|\s)(\S)/gu, (_match, space, letter) => space + letter.toUpperCase());
}

// Radio-Browser's /search endpoint ANDs every field together, so a plain
// name search misses stations that only match by country or state (e.g.
// "Lucerne" or "Switzerland" won't surface Swiss stations whose names don't
// contain those words). Query name/country/state independently and merge.
export async function search(query, limit = 200) {
  const perFieldLimit = limit * 2;
  const settled = await Promise.allSettled([
    stations('json/stations/search', { name: query, limit: perFieldLimit }),
    stations('json/stations/search', { country: titleCase(query), limit: perFieldLimit }),
    stations('json/stations/search', { state: query, limit: perFieldLimit }),
  ]);
  // One flaky field query shouldn't sink the whole search; fail only if all do.
  const results = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!results.length) throw settled[0].reason;
  const merged = [];
  const seen = new Set();
  for (const bucket of results) {
    for (const item of bucket) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  merged.sort((a, b) => b.votes - a.votes);
  return merged.slice(0, limit);
}

export function byTag(tag, limit = 60) {
  return stations(`json/stations/bytag/${encodeURIComponent(tag)}`, { limit });
}

export function byCountryCode(code, limit = 60) {
  return stations(`json/stations/bycountrycodeexact/${encodeURIComponent(code)}`, { limit });
}

// Radio-Browser ranks stations by click count, so this endpoint is both how
// you get a fresh URL and how you vote for the station. The URL it returns
// sometimes points at a playlist file rather than raw audio, so unwrap that
// into the direct stream(s) it lists.
export async function getStreamCandidates(stationUuid) {
  const data = await get(`json/url/${encodeURIComponent(stationUuid)}`);
  if (String(data.ok).toLowerCase() !== 'true') return [];
  const url = safeRemoteUrl(data.url);
  return url ? resolveStreamCandidates(url) : [];
}

export function safeRemoteUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

// `.pls`/`.m3u` playlists point at a stream rather than being one, which a
// plain <audio> element can't play. `.m3u8` is ambiguous: it is also the
// extension HLS uses for its (playable, adaptive-bitrate) manifests, which
// must be left untouched for the client's HLS support to load.
const PLAYLIST_SUFFIXES = ['.pls', '.m3u', '.m3u8'];
const MAX_PLAYLIST_BYTES = 64 * 1024;
const HLS_MANIFEST_MARKERS = [
  '#EXT-X-STREAM-INF',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-KEY',
];

function playlistSuffix(url) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  return PLAYLIST_SUFFIXES.find(suffix => path.endsWith(suffix)) || null;
}

// Playlist URLs come from third-party station data and are fetched
// server-side, so refuse literal loopback, private and link-local targets.
function isInternalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host) || host.startsWith('::ffff:');
  }
  const octets = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function fetchPlaylistText(url) {
  try {
    if (isInternalHost(new URL(url).hostname)) return null;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RadioRoam/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_PLAYLIST_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});
    const limit = Math.min(total, MAX_PLAYLIST_BYTES);
    const bytes = new Uint8Array(limit);
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, limit - offset);
      bytes.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= limit) break;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function parsePlsEntries(text) {
  return [...text.matchAll(/^File\d+\s*=\s*(.+)$/gim)].map(match => match[1].trim());
}

function parseM3uEntries(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

// Unwrap a `.pls`/`.m3u` playlist into the direct stream(s) it lists.
export async function resolveStreamCandidates(url, depth = 0) {
  const suffix = playlistSuffix(url);
  if (depth >= 2 || !suffix) return [url];

  const text = await fetchPlaylistText(url);
  if (text === null) return [url];
  if (suffix === '.m3u8' && HLS_MANIFEST_MARKERS.some(marker => text.includes(marker))) return [url];

  const entries = suffix === '.pls' ? parsePlsEntries(text) : parseM3uEntries(text);
  const resolved = [];
  for (const entry of entries) {
    const candidate = safeRemoteUrl(entry);
    if (!candidate) continue;
    for (const nested of await resolveStreamCandidates(candidate, depth + 1)) {
      if (!resolved.includes(nested)) resolved.push(nested);
    }
  }
  return resolved.length ? resolved : [url];
}

// Tiny time-boxed cache so repeated browsing doesn't hammer the API. This
// lives at module scope, so it's shared across requests handled by the same
// warm isolate and empty again after a cold start - a rough equivalent of
// the Flask app's in-process TTL cache.
export async function cached(key, produce, ttl = CACHE_TTL_MS) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && now - entry.at < ttl) return entry.value;
  if (entry) cache.delete(key);
  const value = await produce();
  // Don't cache an empty result. Radio-Browser occasionally answers a tag
  // query with nothing, and storing that would leave a category looking
  // broken for the full TTL rather than for one request.
  if (value && (!Array.isArray(value) || value.length)) {
    if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, { at: now, value });
  }
  return value;
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

// This limits abuse within each warm Pages Functions isolate. A Cloudflare
// rate-limiting rule should also be configured for globally consistent limits.
export function rateLimit(request, scope, limit, windowMs = 60_000) {
  const client = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = `${scope}:${client}`;
  const now = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || now - entry.startedAt >= windowMs) {
    entry = { count: 0, startedAt: now };
    if (!rateLimits.has(key) && rateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
      rateLimits.delete(rateLimits.keys().next().value);
    }
    rateLimits.set(key, entry);
  }
  entry.count += 1;
  if (entry.count <= limit) return null;

  const retryAfter = Math.max(1, Math.ceil((windowMs - (now - entry.startedAt)) / 1000));
  return jsonResponse(
    { error: 'Too many requests. Please try again shortly.' },
    429,
    { 'retry-after': String(retryAfter) },
  );
}

export async function apiResponse(action) {
  try {
    const result = await action();
    if (result && typeof result === 'object' && !Array.isArray(result) && !result.url) {
      return jsonResponse({ error: 'No playable stream was found.' }, 404);
    }
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof StationNotFound) {
      return jsonResponse({ error: 'That station is no longer listed.' }, 404);
    }
    return jsonResponse({ error: 'Radio-Browser is unavailable right now.' }, 502);
  }
}

// Guess the listener's country from the browser's Accept-Language header.
// Radio-Browser has no geo-targeted feed, and the edge location's own IP
// address is useless - it would report the datacenter. The region subtag of
// the browser locale ("de-CH" -> CH) is imperfect but it at least describes
// the listener rather than the host.
export function listenerCountryCode(request) {
  const header = request.headers.get('accept-language') || '';
  for (const part of header.split(',')) {
    const tag = part.split(';')[0].trim().replace('_', '-');
    const subtags = tag.split('-');
    const region = subtags[subtags.length - 1];
    if (subtags.length > 1 && /^[a-zA-Z]{2}$/.test(region)) return region.toUpperCase();
  }
  return null;
}

// Each category maps to the Radio-Browser tags that best represent it.
// Results for every tag are interleaved so a category isn't dominated by one
// genre.
export const CATEGORY_TAGS = {
  music: ['pop', 'rock', 'jazz', 'electronic', 'classical', 'hip hop'],
  talk: ['talk', 'news', 'public radio', 'comedy'],
  sports: ['sports', 'football', 'basketball'],
};

export async function browseCategory(category, request) {
  if (category === 'local') {
    const code = listenerCountryCode(request);
    return code ? byCountryCode(code) : [];
  }

  const tags = CATEGORY_TAGS[category];
  const buckets = await Promise.all(tags.map(tag => byTag(tag, 15)));
  const merged = [];
  const seen = new Set();
  const longest = Math.max(0, ...buckets.map(bucket => bucket.length));
  // Round-robin the per-tag results so the list stays varied.
  for (let index = 0; index < longest; index += 1) {
    for (const bucket of buckets) {
      const item = bucket[index];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}
