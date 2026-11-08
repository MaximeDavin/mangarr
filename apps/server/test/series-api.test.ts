// The series procedures (add-series flow, detail, editing, rescan, refresh) against recorded
// MangaBaka calls and a temporary library folder.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client";
import { downloads, languages, series } from "../src/db/schema";
import { joinPath, normalizePath } from "../src/library/paths";
import { ensureApiKey } from "../src/settings";
import { apiClient, errorCode, rejection } from "./helpers";
import { recorded } from "./mangabaka-replay";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mangarr-library-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const db = openDatabase(":memory:");
  const api = apiClient(db, { apiKey: ensureApiKey(db) });
  // Inserted directly: the API only accepts POSIX root folders, and tests may run on Windows.
  const addLanguage = (code: string, folder = join(root, code)) =>
    db.insert(languages).values({ code, name: code.toUpperCase(), rootFolder: normalizePath(folder) }).returning().get();
  const en = addLanguage("en");
  return { db, api, en, addLanguage };
}

function files(folder: string, names: string[]) {
  mkdirSync(folder, { recursive: true });
  for (const name of names) writeFileSync(join(folder, name), "x");
}

/** The add-series flow with everything as pre-filled. */
async function addBlueLock(api: ReturnType<typeof setup>["api"], languageId: number, extra: object = {}) {
  const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId });
  return api.series.create({
    languageId,
    mangabakaId: draft.mangabakaId,
    displayTitle: draft.displayTitle,
    searchTerms: draft.searchTerms,
    aliases: draft.aliases,
    ...extra,
  });
}

describe("mangabaka.search", () => {
  it("returns slim results", async () => {
    const { api } = setup();
    const results = await api.mangabaka.search({ query: "berserk", limit: 5 });
    expect(results[0]).toMatchObject({ mangabakaId: recorded.berserk, title: "BERSERK", type: "manga" });
  });
});

describe("series.draft", () => {
  it("pre-fills everything from MangaBaka without saving", async () => {
    const { api, en } = setup();
    const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: en.id });
    expect(draft).toMatchObject({
      mangabakaId: recorded.blueLock,
      existingSeriesId: null,
      displayTitle: "Blue Lock",
      searchTerms: ["Blue Lock", "ブルーロック"],
      authors: ["Muneyuki Kaneshiro", "Yuusuke Nomura"],
      volumeCountFrom: "collection",
      folderPath: joinPath(en.rootFolder, "Blue Lock"),
      folderExists: false,
      folderSeriesId: null,
    });
    expect(draft.volumeCount).toBeGreaterThan(30);
    expect(draft.volumeCountOptions.length).toBeGreaterThan(1);
    expect(await api.series.list({})).toEqual([]);
  });

  it("reports an existing folder and an already-added series", async () => {
    const { api, en } = setup();
    mkdirSync(join(en.rootFolder, "Blue Lock"), { recursive: true });
    expect((await api.series.draft({ mangabakaId: recorded.blueLock, languageId: en.id })).folderExists).toBe(true);
    const added = await addBlueLock(api, en.id);
    const again = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: en.id });
    expect(again).toMatchObject({ existingSeriesId: added.id, folderSeriesId: added.id });
  });

  it("picks an existing folder named after one of the series' titles", async () => {
    const { api, en } = setup();
    files(join(en.rootFolder, "Buruu-Rokku"), ["Buruu Rokku v01.cbz"]);
    files(join(en.rootFolder, "Akira"), []);
    const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: en.id });
    expect(draft).toMatchObject({
      folderPath: joinPath(en.rootFolder, "Buruu-Rokku"),
      folderFrom: "matching_name",
      folderExists: true,
    });

    // Once a series uses it, the next draft doesn't offer it again.
    await api.series.create({
      languageId: en.id,
      mangabakaId: recorded.berserk,
      displayTitle: "Berserk",
      searchTerms: ["Berserk"],
      folderPath: draft.folderPath,
    });
    expect(await api.series.draft({ mangabakaId: recorded.blueLock, languageId: en.id })).toMatchObject({
      folderPath: joinPath(en.rootFolder, "Blue Lock"),
      folderFrom: "display_title",
      folderExists: false,
    });
  });

  it("passes on MangaBaka's not found, and an unknown language", async () => {
    const { api, en } = setup();
    expect(await errorCode(api.series.draft({ mangabakaId: recorded.missing, languageId: en.id }))).toBe("NOT_FOUND");
    expect(await errorCode(api.series.draft({ mangabakaId: recorded.blueLock, languageId: 99 }))).toBe("NOT_FOUND");
  });
});

describe("series.create", () => {
  it("saves the series and its terms, and shows every volume as missing when the folder is new", async () => {
    const { api, en } = setup();
    const created = await addBlueLock(api, en.id);
    expect(created).toMatchObject({
      displayTitle: "Blue Lock",
      folderPath: joinPath(en.rootFolder, "Blue Lock"),
      authors: ["Muneyuki Kaneshiro", "Yuusuke Nomura"],
      publisher: expect.stringContaining("Kodansha"),
      volumeCountSource: "mangabaka",
      language: { id: en.id, code: "en", name: "EN" },
      volumes: [],
      scanWarnings: [],
    });
    expect(created.coverUrl).toStartWith("https://");
    expect(created.externalIds.anilist).toBeNumber();
    expect(created.missing).toHaveLength(created.volumeCount!);
    expect(created.searchTerms.filter((t) => t.kind === "search").map((t) => t.term)).toEqual(["Blue Lock", "ブルーロック"]);
    expect(created.searchTerms.some((t) => t.kind === "alias" && t.term === "Buruu Rokku")).toBe(true);
    expect(created.lastScannedAt).toBeInstanceOf(Date);
    // The folder is created by the first import, not here.
    expect(existsSync(created.folderPath)).toBe(false);
  });

  it("adopts an existing folder and scans it straight away", async () => {
    const { api, en } = setup();
    files(join(en.rootFolder, "Blue Lock"), ["Blue Lock v01.cbz", "Blue Lock v02.cbz", "Blue Lock c100.cbz"]);
    const created = await addBlueLock(api, en.id);
    expect(created.volumes.map((v) => v.number)).toEqual([1, 2]);
    expect(created.missing[0]).toBe(3);
    expect(created.scanWarnings).toEqual([{ file: "Blue Lock c100.cbz", message: "Looks like a chapter, not a volume" }]);
  });

  it("uses another existing folder under the language root, and refuses one outside it or missing", async () => {
    const { api, en } = setup();
    files(join(en.rootFolder, "BLUELOCK (Kodansha)"), ["Blue Lock v05.cbz"]);
    files(join(root, "elsewhere"), []);

    expect(await errorCode(addBlueLock(api, en.id, { folderPath: join(root, "elsewhere") }))).toBe("BAD_REQUEST");
    expect(await errorCode(addBlueLock(api, en.id, { folderPath: join(en.rootFolder, "nope") }))).toBe("BAD_REQUEST");
    expect(await errorCode(addBlueLock(api, en.id, { folderPath: en.rootFolder }))).toBe("BAD_REQUEST");

    const created = await addBlueLock(api, en.id, { folderPath: `${join(en.rootFolder, "BLUELOCK (Kodansha)")}/` });
    // Stored in the same form as the folders mangarr proposes, so ownership checks compare like with like.
    expect(created.folderPath).toBe(joinPath(en.rootFolder, "BLUELOCK (Kodansha)"));
    expect(created.volumes.map((v) => v.number)).toEqual([5]);
  });

  it("adds a manga once per language", async () => {
    const { api, en, addLanguage } = setup();
    await addBlueLock(api, en.id);
    expect(await errorCode(addBlueLock(api, en.id, { displayTitle: "Blue Lock 2" }))).toBe("CONFLICT");
    const fr = addLanguage("fr");
    expect((await addBlueLock(api, fr.id)).language.code).toBe("fr");
  });

  it("refuses a folder another series uses", async () => {
    const { api, en } = setup();
    const first = await addBlueLock(api, en.id);
    const error = await rejection(
      api.series.create({ languageId: en.id, mangabakaId: recorded.berserk, displayTitle: "Blue Lock", searchTerms: ["Berserk"] }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain(first.displayTitle);
  });

  it("marks a volume count as manual only when MangaBaka didn't offer it", async () => {
    const { api, en, addLanguage } = setup();
    const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: en.id });
    const other = draft.volumeCountOptions.find((o) => o.volumeCount !== draft.volumeCount)!;
    expect((await addBlueLock(api, en.id, { volumeCount: other.volumeCount })).volumeCountSource).toBe("mangabaka");

    const fr = addLanguage("fr");
    const manual = await addBlueLock(api, fr.id, { volumeCount: 3 });
    expect(manual).toMatchObject({ volumeCount: 3, volumeCountSource: "manual", missing: [1, 2, 3] });

    const de = addLanguage("de");
    expect(await addBlueLock(api, de.id, { volumeCount: null })).toMatchObject({
      volumeCount: null,
      volumeCountSource: null,
      missing: [],
    });
  });

  it("needs a search term and a usable display title", async () => {
    const { api, en } = setup();
    const base = { languageId: en.id, mangabakaId: recorded.blueLock, displayTitle: "Blue Lock" };
    expect(await errorCode(api.series.create({ ...base, searchTerms: [" ", ""] }))).toBe("BAD_REQUEST");
    expect(await errorCode(api.series.create({ ...base, displayTitle: "???", searchTerms: ["Blue Lock"] }))).toBe("BAD_REQUEST");
  });

  it("drops repeated terms and aliases that are also search terms", async () => {
    const { api, en } = setup();
    const created = await api.series.create({
      languageId: en.id,
      mangabakaId: recorded.blueLock,
      displayTitle: "Blue Lock",
      searchTerms: ["Blue Lock", " Blue Lock ", "BLUELOCK"],
      aliases: ["Blue Lock", "Buruu Rokku", "Buruu Rokku"],
      authors: ["Kaneshiro", "Kaneshiro "],
    });
    expect(created.searchTerms.map((t) => `${t.kind}:${t.term}`)).toEqual([
      "search:Blue Lock",
      "search:BLUELOCK",
      "alias:Buruu Rokku",
    ]);
    expect(created.authors).toEqual(["Kaneshiro"]);
  });
});

describe("series.list and get", () => {
  it("lists series by title with owned counts, filtered by language", async () => {
    const { api, en, addLanguage } = setup();
    files(join(en.rootFolder, "Blue Lock"), ["Blue Lock v01.cbz", "Blue Lock v02.cbz"]);
    await addBlueLock(api, en.id);
    const fr = addLanguage("fr");
    await api.series.create({ languageId: fr.id, mangabakaId: recorded.berserk, displayTitle: "Berserk", searchTerms: ["Berserk"] });

    const all = await api.series.list({});
    expect(all.map((s) => [s.displayTitle, s.ownedCount])).toEqual([
      ["Berserk", 0],
      ["Blue Lock", 2],
    ]);
    expect(all[0]).not.toHaveProperty("metadataJson");
    expect(all.map((s) => s.languageCode)).toEqual(["fr", en.code]);
    expect((await api.series.list({ language: en.code })).map((s) => s.displayTitle)).toEqual(["Blue Lock"]);
    expect(await api.series.list({ language: "xx" })).toEqual([]);
  });

  it("shows missing volumes that an active download covers as downloading", async () => {
    const { db, api, en } = setup();
    files(join(en.rootFolder, "Blue Lock"), ["Blue Lock v01.cbz"]);
    const created = await addBlueLock(api, en.id, { volumeCount: 5 });
    const grab = (infoHash: string, expectedVolumes: number[], status: "downloading" | "imported") =>
      db
        .insert(downloads)
        .values({
          seriesId: created.id,
          infoHash,
          releaseTitle: "x",
          indexerName: "nyaa",
          prowlarrGuid: infoHash,
          size: 1,
          expectedVolumes,
          titleMatch: "exact",
          status,
        })
        .run();
    grab("a".repeat(40), [1, 2, 3], "downloading");
    grab("b".repeat(40), [4], "imported");
    expect(await api.series.get({ id: created.id })).toMatchObject({ missing: [2, 3, 4, 5], downloading: [2, 3] });
  });

  it("reports an unknown series", async () => {
    const { api } = setup();
    expect(await errorCode(api.series.get({ id: 99 }))).toBe("NOT_FOUND");
  });
});

describe("editing", () => {
  it("updates the display title, authors and volume count, which becomes manual", async () => {
    const { api, en } = setup();
    const created = await addBlueLock(api, en.id);
    const updated = await api.series.update({ id: created.id, displayTitle: "BLUE LOCK", authors: ["Kaneshiro"], volumeCount: 2 });
    expect(updated).toMatchObject({
      displayTitle: "BLUE LOCK",
      authors: ["Kaneshiro"],
      volumeCount: 2,
      volumeCountSource: "manual",
      missing: [1, 2],
      // The folder stays where it is.
      folderPath: created.folderPath,
    });
    expect((await api.series.update({ id: created.id, volumeCount: null })).volumeCountSource).toBeNull();
    expect(await api.series.update({ id: created.id })).toMatchObject({ displayTitle: "BLUE LOCK" });
    expect(await errorCode(api.series.update({ id: 99, displayTitle: "x" }))).toBe("NOT_FOUND");
  });

  it("replaces search terms, and needs at least one search term", async () => {
    const { api, en } = setup();
    const created = await addBlueLock(api, en.id);
    const terms = await api.series.replaceSearchTerms({
      id: created.id,
      terms: [
        { term: "Bluelock", kind: "alias" },
        { term: "Blue Lock", kind: "search" },
        { term: "Bluelock", kind: "search" },
      ],
    });
    expect(terms.map((t) => `${t.kind}:${t.term}`)).toEqual(["search:Blue Lock", "search:Bluelock"]);
    expect(
      await errorCode(api.series.replaceSearchTerms({ id: created.id, terms: [{ term: "x", kind: "alias" }] })),
    ).toBe("BAD_REQUEST");
    expect(await errorCode(api.series.replaceSearchTerms({ id: 99, terms: [{ term: "x", kind: "search" }] }))).toBe(
      "NOT_FOUND",
    );
  });

  it("adds an alias, but not one it already has", async () => {
    const { api, en } = setup();
    const created = await addBlueLock(api, en.id);
    expect(await api.series.addSearchTerm({ id: created.id, term: " Blue Lock Episode Nagi ", kind: "alias" })).toMatchObject({
      term: "Blue Lock Episode Nagi",
      kind: "alias",
    });
    expect(await errorCode(api.series.addSearchTerm({ id: created.id, term: "Blue Lock", kind: "alias" }))).toBe("CONFLICT");
  });

  it("rescans the folder", async () => {
    const { api, en } = setup();
    const created = await addBlueLock(api, en.id);
    files(created.folderPath, ["Blue Lock v01.cbz", "Blue Lock.cbz"]);
    const rescanned = await api.series.rescan({ id: created.id });
    expect(rescanned.volumes.map((v) => v.number)).toEqual([1]);
    expect(rescanned.scanWarnings).toEqual([{ file: "Blue Lock.cbz", message: "No volume number in the name" }]);
    expect(await errorCode(api.series.rescan({ id: 99 }))).toBe("NOT_FOUND");
  });

  it("refreshes metadata, changing the volume count only when it came from MangaBaka", async () => {
    const { db, api, en, addLanguage } = setup();
    const fromMangaBaka = await addBlueLock(api, en.id);
    db.update(series).set({ volumeCount: 1, coverUrl: null, status: "old" }).where(eq(series.id, fromMangaBaka.id)).run();
    const refreshed = await api.series.refreshMetadata({ id: fromMangaBaka.id });
    expect(refreshed).toMatchObject({ volumeCount: fromMangaBaka.volumeCount, status: fromMangaBaka.status });
    expect(refreshed.coverUrl).toStartWith("https://");

    const fr = addLanguage("fr");
    const manual = await addBlueLock(api, fr.id, { volumeCount: 3 });
    expect((await api.series.refreshMetadata({ id: manual.id })).volumeCount).toBe(3);
  });

  it("deletes a series but leaves its files", async () => {
    const { api, en } = setup();
    files(join(en.rootFolder, "Blue Lock"), ["Blue Lock v01.cbz"]);
    const created = await addBlueLock(api, en.id);
    await api.series.delete({ id: created.id });
    expect(await api.series.list({})).toEqual([]);
    expect(existsSync(join(created.folderPath, "Blue Lock v01.cbz"))).toBe(true);
    expect(await errorCode(api.series.delete({ id: created.id }))).toBe("NOT_FOUND");
  });
});

describe("languages.folders", () => {
  it("lists the folders in the root, with the series using each", async () => {
    const { api, en } = setup();
    files(join(en.rootFolder, "Blue Lock"), []);
    files(join(en.rootFolder, "Akira"), []);
    files(en.rootFolder, ["stray.cbz"]);
    const created = await addBlueLock(api, en.id);
    expect(await api.languages.folders({ id: en.id })).toEqual([
      { name: "Akira", path: joinPath(en.rootFolder, "Akira"), seriesId: null },
      { name: "Blue Lock", path: joinPath(en.rootFolder, "Blue Lock"), seriesId: created.id },
    ]);
  });

  it("is empty when the root doesn't exist yet", async () => {
    const { api, addLanguage } = setup();
    const fr = addLanguage("fr", join(root, "not-yet"));
    expect(await api.languages.folders({ id: fr.id })).toEqual([]);
  });
});
