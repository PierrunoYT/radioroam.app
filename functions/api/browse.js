import {
  apiResponse,
  browseCategory,
  cached,
  jsonResponse,
  listenerCountryCode,
} from '../_lib/radio-browser.js';

const CATEGORIES = new Set(['music', 'talk', 'sports', 'local']);

export async function onRequestGet({ request }) {
  const category = (new URL(request.url).searchParams.get('category') || 'music').toLowerCase();
  if (!CATEGORIES.has(category)) return jsonResponse({ error: 'Unknown category.' }, 400);

  // "Local" varies per listener, so it's keyed by the country we inferred.
  const key = `${category}:${category === 'local' ? listenerCountryCode(request) : ''}`;
  return apiResponse(() => cached(key, () => browseCategory(category, request)));
}
