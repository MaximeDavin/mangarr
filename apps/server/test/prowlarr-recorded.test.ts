// The Prowlarr client against calls recorded from a real Prowlarr (see scripts/record-prowlarr.ts).
// They prove the integration: the client sends requests Prowlarr accepted (replay only answers
// recorded ones) and reads what Prowlarr really returns. prowlarr.test.ts covers the edge cases.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createProwlarrClient, ProwlarrError } from "../src/integrations/prowlarr";
import { magnetInfoHash, torrentInfoHash } from "../src/integrations/torrent";
import { loadRecording, recordedApiKey, recordedSearches, recordedUrl, replay, type Recording } from "./prowlarr-replay";
import { loadRun, recordedRuns, recordedServices, replayRun, type RunRecording } from "./run-replay";

const client = (...recordings: Recording[]) => {
  const fetch = replay(...recordings);
  return { fetch, prowlarr: createProwlarrClient({ url: recordedUrl, apiKey: recordedApiKey, fetch }) };
};

const warn = spyOn(console, "warn");
afterEach(() => warn.mockClear());

/** The search parameters a recording was made with. */
function searchParams(recording: Recording) {
  const query = recording.request.query;
  const all = (key: string) => query.filter(([k]) => k === key).map(([, v]) => Number(v));
  return {
    query: query.find(([k]) => k === "query")![1],
    indexerIds: all("indexerIds"),
    categories: all("categories"),
  };
}

const searches = recordedSearches();
const byIndexer = (indexerId: number) =>
  searches.map(loadRecording).filter((r) => searchParams(r).indexerIds.includes(indexerId));

it("has recordings to replay", () => {
  expect(searches.length).toBeGreaterThan(0);
});

describe("status", () => {
  it("reads the version", async () => {
    const recording = loadRecording("status");
    expect(await client(recording).prowlarr.status()).toEqual({ version: recording.prowlarrVersion });
  });
});

describe("indexers", () => {
  it("reads every indexer and its categories", async () => {
    const recording = loadRecording("indexers");
    const raw = recording.response.body as { id: number; capabilities?: { categories?: unknown[] } }[];
    const indexers = await client(recording).prowlarr.indexers();
    expect(indexers.map((i) => i.id)).toEqual(raw.map((i) => i.id));
    for (const indexer of indexers) {
      expect(indexer.protocol).toBe("torrent");
      expect(indexer.categories.length).toBeGreaterThan(0);
    }
  });
});

describe.each(searches)("%s", (name) => {
  const recording = loadRecording(name);
  const raw = recording.response.body as unknown[];

  it("sends the recorded request and keeps every result", async () => {
    const { fetch, prowlarr } = client(recording);
    const releases = await prowlarr.search(searchParams(recording));
    expect(fetch.requests).toHaveLength(1);
    expect(releases).toHaveLength(raw.length);
    expect(warn).not.toHaveBeenCalled();
    for (const release of releases) {
      expect(release.protocol).toBe("torrent");
      expect(release.downloadUrl ?? release.magnetUrl).toBeDefined();
      expect(release.publishDate).toBeNumber();
    }
  });
});

it("reads a search with no results as an empty list", async () => {
  const recording = loadRecording("search-no-results");
  expect(await client(recording).prowlarr.search(searchParams(recording))).toEqual([]);
});

describe("what each indexer gives", () => {
  // These document facts the search and grab flows rely on (spec §7.2, §7.3).

  it("Nyaa gives an info-hash and a magnet link for every result", async () => {
    for (const recording of byIndexer(1)) {
      for (const release of await client(recording).prowlarr.search(searchParams(recording))) {
        expect(release.infoHash).toMatch(/^[0-9a-f]{40}$/);
        expect(release.magnetUrl).toStartWith(`${recordedUrl}/1/download?`);
      }
    }
  });

  it("Private Tracker 2 gives only a .torrent download, so duplicates are found by guid and grabbing must hash the file", async () => {
    for (const recording of byIndexer(2)) {
      const releases = await client(recording).prowlarr.search(searchParams(recording));
      for (const release of releases) {
        expect(release.infoHash).toBeUndefined();
        expect(release.magnetUrl).toBeUndefined();
        expect(release.downloadUrl).toStartWith(`${recordedUrl}/2/download?`);
      }
      expect(new Set(releases.map((r) => r.guid)).size).toBe(releases.length);
    }
  });
});

describe("download links", () => {
  // From the whole runs recorded by scripts/try-run.ts --record: Prowlarr's real answers to a grab.
  const runs = recordedRuns().map(loadRun);
  const download = async (recording: RunRecording) => {
    const fetch = replayRun(recording);
    const prowlarr = createProwlarrClient({ url: recordedServices.prowlarr, apiKey: recordedApiKey, fetch });
    const { query, indexerIds, categories } = recording.run;
    const release = (await prowlarr.search({ query, indexerIds, categories })).find((r) => r.title === recording.run.release)!;
    return { release, result: await prowlarr.download((release.magnetUrl ?? release.downloadUrl)!), fetch };
  };

  it("has recorded runs for both kinds of link", () => {
    expect(runs.some((r) => r.run.indexerIds.includes(1))).toBe(true);
    expect(runs.some((r) => r.run.indexerIds.includes(2))).toBe(true);
  });

  it("Nyaa's magnet link is a redirect to the magnet, read without following it", async () => {
    for (const recording of runs.filter((r) => r.run.indexerIds.includes(1))) {
      const { release, result, fetch } = await download(recording);
      expect(result.kind).toBe("magnet");
      const uri = (result as { uri: string }).uri;
      expect(magnetInfoHash(uri)).toBe(recording.run.infoHash);
      // The hash Prowlarr gave in the search is the same one.
      expect(release.infoHash).toBe(recording.run.infoHash);
      expect(fetch.requests.at(-1)!.redirect).toBe("manual");
    }
  });

  it("Private Tracker 2's link sends the .torrent itself, whose v1 hash qBittorrent then reported", async () => {
    for (const recording of runs.filter((r) => r.run.indexerIds.includes(2))) {
      const { result } = await download(recording);
      expect(result.kind).toBe("torrent");
      expect(torrentInfoHash((result as { bytes: Uint8Array }).bytes)).toBe(recording.run.infoHash);
    }
  });
});

describe("errors", () => {
  it("passes on Prowlarr's message when no selected indexer is available", async () => {
    const recording = loadRecording("error-unknown-indexer");
    const error = await client(recording)
      .prowlarr.search(searchParams(recording))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProwlarrError);
    expect(error).toMatchObject({
      kind: "http",
      status: 400,
      message: "Prowlarr answered 400: Search failed due to all selected indexers being unavailable",
    });
  });

  it("reports a wrong API key", async () => {
    const error = await client(loadRecording("error-wrong-api-key"))
      .prowlarr.status()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
  });
});
