import { apiResponse, cached, jsonResponse, rateLimit, search } from '../_lib/radio-browser.js';

export async function onRequestGet({ request }) {
  const limited = rateLimit(request, 'search', 30);
  if (limited) return limited;

  const query = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!query) return jsonResponse({ error: 'Enter a station, show, or genre.' }, 400);
  if (query.length > 100) {
    return jsonResponse({ error: 'Searches must be 100 characters or fewer.' }, 400);
  }
  if (new URL(request.url).searchParams.get('debug') === '1') {
    const result = await search(query);
    return jsonResponse({ build: 'search-merge-v2', count: result.length, countries: [...new Set(result.map(s => s.country))] });
  }
  return apiResponse(() => cached(`search:${query.toLocaleLowerCase()}`, () => search(query), 60_000));
}
