// Interactive search (spec §7.2): ranking on its own, then the procedure against recorded Prowlarr searches.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { openDatabase } from "../src/db/client";
import { languages, searchTerms, series, volumes } from "../src/db/schema";
import type { ProwlarrRelease } from "../src/integrations/prowlarr";
import { rankReleases } from "../src/library/search";
import { ensureApiKey, setSetting } from "../src/settings";
import { apiClient, errorCode } from "./helpers";
import { loadRecording, recordedApiKey, recordedUrl, replay } from "./prowlarr-replay";

let guid = 0;
function release(title: string, extra: Partial<ProwlarrRelease> = {}): ProwlarrRelease {
  guid++;
  return { guid: `g${guid}`, title, size: 1, indexerId: 1, indexer: "Nyaa", protocol: "torrent", ...extra };
}

const berserk = {
  names: ["Berserk"],
  authors: ["Kentaro Miura"],
  owned: [] as number[],
  volumeCount: 42 as number | null,
};
const titles = (outcome: ReturnType<typeof rankReleases>) => outcome.results.map((r) => r.release.title);

describe("rankReleases", () => {
  it("drops chapter and usenet releases and counts them", () => {
    const outcome = rankReleases(
      [release("Berserk v01"), release("Berserk c377"), release("Berserk v02", { protocol: "usenet" })],
      berserk,
    );
    expect(titles(outcome)).toEqual(["Berserk v01"]);
    expect(outcome).toMatchObject({ received: 3, chapterReleases: 1, usenetReleases: 1 });
  });

  it("removes duplicates by info-hash, then by guid, keeping the most seeded copy", () => {
    const hash = "a".repeat(40);
    const outcome = rankReleases(
      [
        release("Berserk v01 (Nyaa)", { infoHash: hash, seeders: 3 }),
        release("Berserk v01 (other)", { infoHash: hash, seeders: 9 }),
        release("Berserk v02", { guid: "same" }),
        release("Berserk v02", { guid: "same" }),
      ],
      berserk,
    );
    expect(titles(outcome)).toEqual(["Berserk v01 (other)", "Berserk v02"]);
  });

  it("sorts by title match, then missing volumes, then seeders", () => {
    const outcome = rankReleases(
      [
        release("Berserk of Gluttony v01-14", { seeders: 50 }),
        release("Kentaro.Miura.Berserk.T43.FR.cbz", { seeders: 40 }),
        release("Berserk v01", { seeders: 30 }),
        release("Berserk v40", { seeders: 5 }),
        release("Berserk v41", { seeders: 10 }),
      ],
      { ...berserk, owned: [1] },
    );
    expect(outcome.results.map((r) => [r.release.title, r.match, r.coversMissing])).toEqual([
      ["Berserk v41", "exact", true],
      ["Berserk v40", "exact", true],
      ["Berserk v01", "exact", false],
      ["Kentaro.Miura.Berserk.T43.FR.cbz", "partial", true],
      ["Berserk of Gluttony v01-14", "none", true],
    ]);
  });

  it("lists the volumes a release brings that the series doesn't own", () => {
    const [result] = rankReleases([release("Berserk v01-05")], { ...berserk, owned: [2, 4] }).results;
    expect(result!.newVolumes).toEqual([1, 3, 5]);
    // Beyond the known count still counts: digital often runs ahead.
    expect(rankReleases([release("Berserk v43")], berserk).results[0]!.coversMissing).toBe(true);
  });

  it("counts a complete pack with no numbers as covering missing volumes unless every volume is owned", () => {
    const pack = () => [release("Berserk (Complete)")];
    const all = Array.from({ length: 42 }, (_, i) => i + 1);
    expect(rankReleases(pack(), berserk).results[0]!.coversMissing).toBe(true);
    expect(rankReleases(pack(), { ...berserk, owned: all }).results[0]!.coversMissing).toBe(false);
    expect(rankReleases(pack(), { ...berserk, owned: all, volumeCount: null }).results[0]!.coversMissing).toBe(true);
  });
});

// ---- The procedure ----

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

/** Prowlarr answered by the recordings; a query nothing recorded makes the call fail. */
function recordedProwlarr() {
  const fetch = replay(loadRecording("search-private-tracker-2"), loadRecording("search-nyaa-si"));
  spyOn(globalThis, "fetch").mockImplementation(fetch as unknown as typeof globalThis.fetch);
  return fetch.requests;
}

/** Berserk in French on Private Tracker 2 (indexer 2), as the recordings were made. */
function setup({ indexerIds = [2], configured = true } = {}) {
  const db = openDatabase(":memory:");
  const api = apiClient(db, { apiKey: ensureApiKey(db) });
  if (configured) {
    setSetting(db, "prowlarrUrl", recordedUrl);
    setSetting(db, "prowlarrApiKey", recordedApiKey);
  }
  const fr = db
    .insert(languages)
    .values({
      code: "fr",
      name: "Français",
      rootFolder: "/data/fr",
      prowlarrIndexerIds: indexerIds,
      prowlarrCategories: [7000],
    })
    .returning()
    .get();
  const row = db
    .insert(series)
    .values({
      languageId: fr.id,
      mangabakaId: 1,
      displayTitle: "Berserk",
      folderPath: "/data/fr/Berserk",
      authors: ["Kentaro Miura"],
      volumeCount: 43,
    })
    .returning()
    .get();
  db.insert(searchTerms)
    .values([
      { seriesId: row.id, term: "berserk", kind: "search" },
      // Never queried: the replay would fail on it.
      { seriesId: row.id, term: "Berserk Édition Prestige", kind: "alias" },
    ])
    .run();
  const owned = [1, 2, 3, 41];
  db.insert(volumes)
    .values(
      owned.map((number) => ({
        seriesId: row.id,
        number,
        filePath: `/data/fr/Berserk/v${number}.cbz`,
        fileSize: 1,
        format: "cbz" as const,
        source: "scan" as const,
      })),
    )
    .run();
  return { db, api, seriesId: row.id };
}

describe("releases.search", () => {
  it("queries each search term on the language's indexers and ranks the results", async () => {
    const requests = recordedProwlarr();
    const { api, seriesId } = setup();
    const out = await api.releases.search({ id: seriesId });

    expect(requests).toHaveLength(1);
    expect(out).toMatchObject({ queries: ["berserk"], received: 59, chapterReleases: 1, usenetReleases: 0 });
    expect(out.results).toHaveLength(58);
    expect(out.results[0]).toMatchObject({
      title: "Berserk_FR_01-42",
      match: "exact",
      coversMissing: true,
      indexer: "Private Tracker 2",
    });
    expect(out.results[0]!.newVolumes).toHaveLength(42 - 4);
    expect(out.results.find((r) => r.title.startsWith("Kentaro.Miura.Berserk.T43"))).toMatchObject({
      match: "partial",
      parsedTitle: "Kentaro Miura Berserk",
      volumes: [43],
    });
    expect(out.results.find((r) => r.title.startsWith("Berserk of Gluttony Tome"))?.match).toBe("none");
    // Matches come first.
    const ranks = out.results.map((r) => ({ exact: 2, partial: 1, none: 0 })[r.match]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it("never returns Prowlarr's download links, which hold its API key", async () => {
    recordedProwlarr();
    const { api, seriesId } = setup();
    const out = await api.releases.search({ id: seriesId });
    expect(JSON.stringify(out)).not.toContain(recordedApiKey);
    expect(out.results[0]).not.toHaveProperty("downloadUrl");
  });

  it("needs indexers for the language and Prowlarr settings", async () => {
    const requests = recordedProwlarr();
    const noIndexers = setup({ indexerIds: [] });
    expect(await errorCode(noIndexers.api.releases.search({ id: noIndexers.seriesId }))).toBe("PRECONDITION_FAILED");
    const unconfigured = setup({ configured: false });
    expect(await errorCode(unconfigured.api.releases.search({ id: unconfigured.seriesId }))).toBe(
      "PRECONDITION_FAILED",
    );
    expect(await errorCode(unconfigured.api.releases.search({ id: 999 }))).toBe("NOT_FOUND");
    expect(requests).toHaveLength(0);
  });
});
