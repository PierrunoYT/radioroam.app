import {
  apiResponse,
  browseCategory,
  cached,
  jsonResponse,
  listenerCountryCode,
  rateLimit,
} from '../_lib/radio-browser.js';

const CATEGORIES = new Set(['music', 'talk', 'sports', 'local']);

export async function onRequestGet({ request }) {
  const limited = rateLimit(request, 'browse', 60);
  if (limited) return limited;

  const category = (new URL(request.url).searchParams.get('category') || 'music').toLowerCase();
  if (!CATEGORIES.has(category)) return jsonResponse({ error: 'Unknown category.' }, 400);

  // "Local" varies per listener, so it's keyed by the country we inferred.
  const key = `browse:${category}:${category === 'local' ? listenerCountryCode(request) : ''}`;
  const response = await apiResponse(() => cached(key, () => browseCategory(category, request)));
  if (category === 'local') {
    response.headers.set('cache-control', 'private, no-store');
    response.headers.set('vary', 'Accept-Language');
  }
  return response;
}
