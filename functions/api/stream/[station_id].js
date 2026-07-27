import { apiResponse, cached, getStreamUrl, jsonResponse, rateLimit } from '../../_lib/radio-browser.js';

export async function onRequestGet({ params, request }) {
  const limited = rateLimit(request, 'stream', 20);
  if (limited) return limited;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(params.station_id)) {
    return jsonResponse({ error: 'Invalid station ID.' }, 400);
  }

  return apiResponse(async () => {
    const url = await cached(
      `stream:${params.station_id}`,
      () => getStreamUrl(params.station_id),
      30_000,
    );
    return { url, urls: url ? [url] : [] };
  });
}
