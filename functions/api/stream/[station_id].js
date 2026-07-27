import { apiResponse, getStreamUrl } from '../../_lib/radio-browser.js';

export async function onRequestGet({ params }) {
  return apiResponse(async () => {
    const url = await getStreamUrl(params.station_id);
    return { url, urls: url ? [url] : [] };
  });
}
