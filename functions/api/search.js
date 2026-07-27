import { apiResponse, jsonResponse, search } from '../_lib/radio-browser.js';

export async function onRequestGet({ request }) {
  const query = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!query) return jsonResponse({ error: 'Enter a station, show, or genre.' }, 400);
  return apiResponse(() => search(query));
}
