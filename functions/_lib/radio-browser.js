// Client for the Radio-Browser directory API, ported from the Flask app's
// RadioBrowserAPI so the Pages Functions serve the same shape of data.

const HOSTS = ['https://all.api.radio-browser.info', 'https://de1.api.radio-browser.info'];
const DEFAULTS = { hidebroken: 'true', order: 'clickcount', reverse: 'true' };

export class StationNotFound extends Error {}

async function get(path, params = {}) {
  const query = new URLSearchParams({ ...DEFAULTS, ...params });
  let lastError = new Error('no hosts configured');
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}/${path.replace(/^\//, '')}?${query}`, {
        headers: { 'User-Agent': 'RadioRoam/1.0' },
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
  const url = item.url_resolved || item.url;
  return {
    id: item.stationuuid,
    name: (item.name || 'Unknown station').trim(),
    subtext: subtext || 'Live radio',
    image: item.favicon || null,
    formats: item.codec || null,
    bitrate: item.bitrate || null,
    country: item.country || null,
    homepage: item.homepage || null,
    votes: item.votes || 0,
    url,
  };
}

async function stations(path, params) {
  const payload = await get(path, params);
  return payload.filter(item => item.stationuuid).map(toStation);
}

export function search(query, limit = 60) {
  return stations('json/stations/search', { name: query, limit });
}

export function byTag(tag, limit = 60) {
  return stations(`json/stations/bytag/${encodeURIComponent(tag)}`, { limit });
}

export function byCountryCode(code, limit = 60) {
  return stations(`json/stations/bycountrycodeexact/${encodeURIComponent(code)}`, { limit });
}

// Radio-Browser ranks stations by click count, so this endpoint is both how
// you get a fresh URL and how you vote for the station.
export async function getStreamUrl(stationUuid) {
  const data = await get(`json/url/${encodeURIComponent(stationUuid)}`);
  return String(data.ok).toLowerCase() === 'true' ? data.url : null;
}

// Tiny time-boxed cache so repeated browsing doesn't hammer the API. This
// lives at module scope, so it's shared across requests handled by the same
// warm isolate and empty again after a cold start - a rough equivalent of
// the Flask app's in-process TTL cache.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export async function cached(key, produce) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && now - entry.at < CACHE_TTL_MS) return entry.value;
  const value = await produce();
  // Don't cache an empty result. Radio-Browser occasionally answers a tag
  // query with nothing, and storing that would leave a category looking
  // broken for the full TTL rather than for one request.
  if (value && value.length) cache.set(key, { at: now, value });
  return value;
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
