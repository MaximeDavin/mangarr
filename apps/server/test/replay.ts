// Replays HTTP calls recorded from a real service (test/fixtures/<service>/*.json).

import type { Fetch } from "../src/integrations/prowlarr";

export interface RecordedCall {
  /** What the recording shows, for whoever reads the fixture. */
  description: string;
  recordedAt: string;
  request: { method: "GET"; path: string; query: [string, string][] };
  response: { status: number; contentType: string | null; body: unknown };
}

const sortedQuery = (pairs: Iterable<[string, string]>) =>
  [...pairs]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");

/**
 * A fetch that answers with the recording whose path and query match the request (in any order),
 * against `baseUrl`. A request no recording matches throws, so a test fails as soon as the client
 * asks for something new.
 */
export function replayAt(baseUrl: string, recordings: RecordedCall[]): Fetch & { requests: Request[] } {
  const requests: Request[] = [];
  const fetch = async (request: Request) => {
    requests.push(request);
    const url = new URL(request.url);
    const recording = recordings.find(
      (r) =>
        r.request.method === request.method &&
        `${baseUrl}${r.request.path}` === `${url.origin}${url.pathname}` &&
        sortedQuery(r.request.query) === sortedQuery(url.searchParams),
    );
    if (!recording) throw new Error(`No recording for ${request.method} ${url.pathname}${url.search}`);
    const { status, contentType, body } = recording.response;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, {
      status,
      headers: contentType ? { "content-type": contentType } : {},
    });
  };
  return Object.assign(fetch, { requests });
}
