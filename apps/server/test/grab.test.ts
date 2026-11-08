// Grab (spec §7.3): recorded Prowlarr searches, a fake Prowlarr download proxy and a fake qBittorrent.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/db/client";
import { downloads, languages, searchTerms, series } from "../src/db/schema";
import { ReleaseCache } from "../src/library/release-cache";
import { ensureApiKey, setSetting } from "../src/settings";
import { bencode, sampleTorrent } from "./bencode";
import { fakeQBittorrent } from "./fake-qbittorrent";
import { apiClient, rejection } from "./helpers";
import { loadRecording, recordedApiKey, recordedUrl, replay } from "./prowlarr-replay";

/** The hash in Nyaa's recorded "Berserk v42" magnet. */
const nyaaHash = "8247b1178fd004b08457ef62e851e12b1c85eba3";
const torrent = sampleTorrent("Berserk_FR_01-42");
const torrentHash = createHash("sha1").update(bencode(torrent.info)).digest("hex");

afterEach(() => (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.());

/**
 * Prowlarr's download proxy: indexer 1 (Nyaa) redirects to a magnet, indexer 2 (Private Tracker 2) sends a .torrent.
 * `proxy` replaces that answer.
 */
function services({ proxy }: { proxy?: (request: Request) => Response } = {}) {
  const qbit = fakeQBittorrent();
  const search = replay(loadRecording("search-private-tracker-2"), loadRecording("search-nyaa-si"));
  const proxied: Request[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (request: Request) => {
    if (qbit.handles(request)) return qbit.fetch(request);
    const { pathname } = new URL(request.url);
    const download = /^\/(\d+)\/download$/.exec(pathname);
    if (request.url.startsWith(recordedUrl) && download) {
      proxied.push(request);
      if (proxy) return proxy(request);
      if (download[1] === "1") {
        return new Response(null, {
          status: 301,
          headers: { location: `magnet:?xt=urn:btih:${nyaaHash}&dn=Berserk+v42` },
        });
      }
      return new Response(torrent.bytes, { headers: { "content-type": "application/x-bittorrent" } });
    }
    return search(request);
  }) as unknown as typeof fetch);
  return { qbit, proxied };
}

/** Berserk searched on Nyaa (indexer 1) or Private Tracker 2 (indexer 2), as the recordings were made. */
function setup(indexerId: 1 | 2, { qbittorrent = true } = {}) {
  const db = openDatabase(":memory:");
  const releases = new ReleaseCache();
  const api = apiClient(db, { apiKey: ensureApiKey(db), releases });
  setSetting(db, "prowlarrUrl", recordedUrl);
  setSetting(db, "prowlarrApiKey", recordedApiKey);
  if (qbittorrent) {
    setSetting(db, "qbittorrentUrl", "http://qbittorrent:8080");
    setSetting(db, "qbittorrentUsername", "admin");
    setSetting(db, "qbittorrentPassword", "secret");
  }
  const language = db
    .insert(languages)
    .values({
      code: "xx",
      name: "Test",
      rootFolder: "/data/xx",
      prowlarrIndexerIds: [indexerId],
      prowlarrCategories: [7000],
    })
    .returning()
    .get();
  const row = db
    .insert(series)
    .values({
      languageId: language.id,
      mangabakaId: 1,
      displayTitle: "Berserk",
      folderPath: "/data/xx/Berserk",
      authors: ["Kentaro Miura"],
    })
    .returning()
    .get();
  db.insert(searchTerms).values({ seriesId: row.id, term: "berserk", kind: "search" }).run();
  return { db, api, seriesId: row.id };
}

async function searchFor(api: ReturnType<typeof setup>["api"], seriesId: number, title: string) {
  const out = await api.releases.search({ id: seriesId });
  const result = out.results.find((r) => r.title === title);
  if (!result) throw new Error(`no result "${title}"`);
  return result;
}

describe("releases.grab", () => {
  it("sends a .torrent from the proxy to qBittorrent and tracks it by its computed hash", async () => {
    const { qbit, proxied } = services();
    const { api, seriesId } = setup(2);
    const result = await searchFor(api, seriesId, "Berserk_FR_01-42");
    expect(result.infoHash).toBeUndefined();

    const download = await api.releases.grab({ id: seriesId, guid: result.guid });
    expect(download).toMatchObject({
      seriesId,
      infoHash: torrentHash,
      releaseTitle: "Berserk_FR_01-42",
      indexerName: "Private Tracker 2",
      prowlarrGuid: result.guid,
      titleMatch: "exact",
      status: "downloading",
    });
    expect(download.expectedVolumes).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
    expect(proxied[0]!.redirect).toBe("manual");
    expect([...qbit.state.categories]).toEqual(["mangarr"]);
    expect(qbit.state.added).toEqual([{ category: "mangarr", magnet: undefined, torrent: torrent.bytes }]);

    // The next search marks it.
    expect((await searchFor(api, seriesId, "Berserk_FR_01-42")).grabbed).toBe(true);
  });

  it("follows the proxy's redirect to a magnet link", async () => {
    const { qbit } = services();
    const { api, seriesId } = setup(1);
    const result = await searchFor(api, seriesId, "Berserk v42 (2025) (Digital) (LuCaZ)");
    const download = await api.releases.grab({ id: seriesId, guid: result.guid });
    expect(download).toMatchObject({ infoHash: nyaaHash, expectedVolumes: [42], indexerName: "Nyaa.si" });
    expect(qbit.state.added).toEqual([
      { category: "mangarr", magnet: `magnet:?xt=urn:btih:${nyaaHash}&dn=Berserk+v42`, torrent: undefined },
    ]);
  });

  it("refuses a release that was already grabbed", async () => {
    const { qbit } = services();
    const { api, seriesId } = setup(1);
    const result = await searchFor(api, seriesId, "Berserk v42 (2025) (Digital) (LuCaZ)");
    await api.releases.grab({ id: seriesId, guid: result.guid });
    const error = await rejection(api.releases.grab({ id: seriesId, guid: result.guid }));
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("This torrent was already grabbed for Berserk");
    expect(qbit.state.added).toHaveLength(1);
  });

  it("refuses a torrent qBittorrent already has, without adding it", async () => {
    const { qbit } = services();
    qbit.state.torrents.push({
      hash: torrentHash,
      name: "added by hand",
      category: "",
      state: "uploading",
      progress: 1,
      amount_left: 0,
    });
    const { db, api, seriesId } = setup(2);
    const result = await searchFor(api, seriesId, "Berserk_FR_01-42");
    const error = await rejection(api.releases.grab({ id: seriesId, guid: result.guid }));
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain('"added by hand"');
    expect(qbit.state.added).toHaveLength(0);
    expect(db.select().from(downloads).all()).toHaveLength(0);
  });

  it("needs a recent search", async () => {
    services();
    const { api, seriesId } = setup(2);
    const error = await rejection(api.releases.grab({ id: seriesId, guid: "never-searched" }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("Search again");
    expect((await rejection(api.releases.grab({ id: 999, guid: "x" }))).code).toBe("NOT_FOUND");
  });

  it("checks qBittorrent settings before fetching the torrent", async () => {
    const { proxied } = services();
    const { api, seriesId } = setup(2, { qbittorrent: false });
    const result = await searchFor(api, seriesId, "Berserk_FR_01-42");
    expect((await rejection(api.releases.grab({ id: seriesId, guid: result.guid }))).code).toBe("PRECONDITION_FAILED");
    expect(proxied).toHaveLength(0);
  });

  it("rejects v2-only torrents and things that aren't torrents", async () => {
    const v2 = bencode({ info: { name: "x", "piece length": 16384, "meta version": 2, "file tree": {} } });
    let answer = new Response(v2);
    services({ proxy: () => answer });
    const { api, seriesId } = setup(2);
    const result = await searchFor(api, seriesId, "Berserk_FR_01-42");

    const error = await rejection(api.releases.grab({ id: seriesId, guid: result.guid }));
    expect([error.code, error.message]).toEqual(["UNPROCESSABLE_CONTENT", "v2-only torrents are not supported"]);

    answer = new Response("<html>Log in to Private Tracker 2</html>");
    const html = await rejection(api.releases.grab({ id: seriesId, guid: result.guid }));
    expect([html.code, html.message]).toEqual([
      "BAD_GATEWAY",
      "The indexer sent something that is not a .torrent file",
    ]);
  });

  it("reports a failed download without the link, which holds Prowlarr's API key", async () => {
    services({ proxy: () => Response.json({ message: "Indexer Private Tracker 2 is unavailable" }, { status: 500 }) });
    const { api, seriesId } = setup(2);
    const result = await searchFor(api, seriesId, "Berserk_FR_01-42");
    const error = await rejection(api.releases.grab({ id: seriesId, guid: result.guid }));
    expect(error.code).toBe("BAD_GATEWAY");
    expect(error.message).toBe("Prowlarr could not get the torrent (500): Indexer Private Tracker 2 is unavailable");
    expect(error.message).not.toContain("apikey");
  });
});

describe("ReleaseCache", () => {
  it("forgets results after the TTL and when the series is searched again", () => {
    let now = 0;
    const cache = new ReleaseCache(1000, () => now);
    const result = { release: { guid: "a" } } as never;
    cache.set(1, [result]);
    expect(cache.get(1, "a")).toBe(result);
    expect(cache.get(2, "a")).toBeUndefined();
    cache.set(1, []);
    expect(cache.get(1, "a")).toBeUndefined();
    cache.set(1, [result]);
    now = 1000;
    expect(cache.get(1, "a")).toBeUndefined();
  });
});
