// The Manga-News dataset (spec §4.7, §6.5, §7.1): parsing the CSV, refreshing the table, title
// search, and linking a row to a series. The fixture is real rows from the July 2026 file.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client";
import { languages, mangaNewsSeries, series } from "../src/db/schema";
import { downloadMangaNewsCsv, parseCsv, parseMangaNewsCsv } from "../src/integrations/manganews";
import { UpstreamError } from "../src/integrations/upstream";
import {
  mangaNewsDisplayTitle,
  mangaNewsSearchTitle,
  searchMangaNews,
  storeMangaNewsDataset,
} from "../src/library/manganews";
import { normalizePath } from "../src/library/paths";
import { ensureApiKey, setSetting } from "../src/settings";
import { apiClient, errorCode, rejection } from "./helpers";
import { recorded } from "./mangabaka-replay";

const csv = readFileSync(join(import.meta.dir, "fixtures/manganews/series-sample.csv"), "utf8");
const header = csv.slice(0, csv.indexOf("\n"));
/** The fixture with some rows changed: `edit` gets each data line and returns its replacement (or null to drop it). */
const variant = (edit: (line: string) => string | null) =>
  [
    header,
    ...csv
      .slice(header.length + 1)
      .split("\n")
      .filter(Boolean)
      .map(edit)
      .filter((l) => l !== null),
  ].join("\n");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mangarr-manganews-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF, a BOM and a missing last newline", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });
});

describe("parseMangaNewsCsv", () => {
  it("reads every row of the real file's layout", () => {
    const { rows, skipped } = parseMangaNewsCsv(csv);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(13);
    expect(rows.find((r) => r.id === 456)).toEqual({
      id: 456,
      url: "https://www.manga-news.com/index.php/serie/Berserk-2Ed",
      title: "Berserk",
      publisher: "Glénat",
      volumeCount: 43,
      artists: "Kentarô MIURA",
      writers: null,
      genres: ["Aventure", "Fantastique"],
      coverUrl: expect.stringContaining("manga-news.com/public/images/series/"),
    });
    expect(rows.find((r) => r.id === 30338)?.title).toBe("1,2,3,4,5 et Roku");
  });

  it("finds columns by name, and skips lines it can't use", () => {
    const reordered = [
      "title,volumes,site_id,publisher,url",
      "Berserk,43,456,Glénat,https://x/1",
      ",3,2,P,https://x/2",
      "Bad,many,3,P,https://x/3",
      "Again,1,456,P,https://x/4",
      "",
    ].join("\n");
    const { rows, skipped } = parseMangaNewsCsv(reordered);
    expect(rows).toEqual([
      {
        id: 456,
        url: "https://x/1",
        title: "Berserk",
        publisher: "Glénat",
        volumeCount: 43,
        artists: null,
        writers: null,
        genres: [],
        coverUrl: null,
      },
    ]);
    expect(skipped).toBe(3);
  });

  it("refuses a file without the columns it needs", () => {
    expect(() => parseMangaNewsCsv("<!doctype html><html>")).toThrow("not the Manga-News CSV");
    expect(() => parseMangaNewsCsv("site_id,title\n1,Berserk")).toThrow("no url, publisher, volumes column");
  });
});

describe("titles", () => {
  it("moves a trailing article to the front", () => {
    expect(mangaNewsSearchTitle("Envol (l')")).toBe("lenvol");
    expect(mangaNewsSearchTitle("Aventures de Tom Sawyer (les)")).toBe("les aventures de tom sawyer");
    expect(mangaNewsSearchTitle("(Extra)ordinaire")).toBe("extra ordinaire");
    expect(mangaNewsDisplayTitle("Envol (l')")).toBe("L'Envol");
    expect(mangaNewsDisplayTitle("Aventures de Tom Sawyer (les)")).toBe("Les Aventures de Tom Sawyer");
    expect(mangaNewsDisplayTitle("Berserk")).toBe("Berserk");
  });
});

describe("storeMangaNewsDataset and search", () => {
  function loaded() {
    const db = openDatabase(":memory:");
    const first = storeMangaNewsDataset(db, parseMangaNewsCsv(csv), new Date(1_000));
    return { db, first };
  }

  it("loads the file", () => {
    const { first } = loaded();
    expect(first).toEqual({
      rowCount: 13,
      importedAt: new Date(1_000),
      added: 13,
      removed: 0,
      skipped: 0,
      seriesUpdated: 0,
      seriesUnlinked: 0,
    });
  });

  it("ranks the same title first, then titles starting with it, by most volumes", () => {
    const { db } = loaded();
    expect(searchMangaNews(db, "berserk").map((r) => r.title)).toEqual([
      "Berserk",
      "Berserk of Gluttony",
      "Berserk - Roman",
    ]);
    expect(searchMangaNews(db, "one piece").map((r) => r.title)).toEqual(["One Piece", "One Piece - Doors"]);
    expect(searchMangaNews(db, "lock blue")[0]?.title).toBe("Blue Lock");
    expect(searchMangaNews(db, "Frièren", 1).map((r) => r.id)).toEqual([29402]);
  });

  it("finds titles filed with the article at the end, with or without it", () => {
    const { db } = loaded();
    expect(
      searchMangaNews(db, "l'envol")
        .map((r) => r.id)
        .sort((a, b) => a - b),
    ).toEqual([872, 27260]);
    expect(
      searchMangaNews(db, "envol")
        .map((r) => r.id)
        .sort((a, b) => a - b),
    ).toEqual([872, 27260]);
    expect(searchMangaNews(db, "Les aventures de Tom Sawyer").map((r) => r.id)).toEqual([20893]);
    expect(searchMangaNews(db, "tom sawyer").map((r) => r.id)).toEqual([20893]);
  });

  it("matches nothing for a query with no letters or digits, LIKE wildcards included", () => {
    const { db } = loaded();
    expect(searchMangaNews(db, "%")).toEqual([]);
    expect(searchMangaNews(db, "_ - !")).toEqual([]);
  });

  it("updates rows in place, removes dropped ones, and keeps series links", () => {
    const { db } = loaded();
    const language = db
      .insert(languages)
      .values({ code: "fr", name: "French", rootFolder: "/data/fr" })
      .returning()
      .get();
    const add = (values: Partial<typeof series.$inferInsert>) =>
      db
        .insert(series)
        .values({
          languageId: language.id,
          mangabakaId: Math.floor(Math.random() * 1e9),
          displayTitle: "x",
          folderPath: `/data/fr/${Math.random()}`,
          ...values,
        })
        .returning()
        .get();
    const followed = add({ mangaNewsSeriesId: 456, volumeCount: 43, volumeCountSource: "manganews" });
    const manual = add({ mangaNewsSeriesId: 27713, volumeCount: 30, volumeCountSource: "manual" });
    const dropped = add({ mangaNewsSeriesId: 29402, volumeCount: 15, volumeCountSource: "manganews" });

    const next = variant((line) => {
      if (line.startsWith("456,")) return line.replace(",Glénat,43,", ",Glénat,44,");
      if (line.startsWith("27713,")) return line.replace(",Pika,33,", ",Pika,34,");
      if (line.startsWith("29402,")) return null;
      return line;
    });
    const result = storeMangaNewsDataset(
      db,
      parseMangaNewsCsv(`${next}\n99999,https://x/new,Nouveau,N,Kana,2,,,,,,`),
      new Date(2_000),
    );
    expect(result).toMatchObject({ rowCount: 13, added: 1, removed: 1, seriesUpdated: 1, seriesUnlinked: 1 });

    const get = (id: number) => db.select().from(series).where(eq(series.id, id)).get()!;
    expect(get(followed.id)).toMatchObject({ mangaNewsSeriesId: 456, volumeCount: 44, volumeCountSource: "manganews" });
    expect(get(manual.id)).toMatchObject({ mangaNewsSeriesId: 27713, volumeCount: 30, volumeCountSource: "manual" });
    expect(get(dropped.id)).toMatchObject({ mangaNewsSeriesId: null, volumeCount: 15, volumeCountSource: "manual" });
    expect(db.select().from(mangaNewsSeries).where(eq(mangaNewsSeries.id, 29402)).get()).toBeUndefined();
  });

  it("refreshes twice in the same millisecond without losing rows", () => {
    const db = openDatabase(":memory:");
    const at = new Date(5_000);
    storeMangaNewsDataset(db, parseMangaNewsCsv(csv), at);
    expect(storeMangaNewsDataset(db, parseMangaNewsCsv(csv), at)).toMatchObject({ rowCount: 13, removed: 0 });
    expect(searchMangaNews(db, "berserk")).toHaveLength(3);
  });

  it("refuses a file with no rows and keeps the current dataset", () => {
    const { db } = loaded();
    expect(() => storeMangaNewsDataset(db, { rows: [], skipped: 4 })).toThrow("no rows");
    expect(searchMangaNews(db, "berserk")).toHaveLength(3);
  });
});

describe("downloadMangaNewsCsv", () => {
  it("returns the text, and names the host on failures", async () => {
    expect(
      await downloadMangaNewsCsv("https://static.data.gouv.fr/x.csv", { fetch: async () => new Response(csv) }),
    ).toBe(csv);
    const missing = await rejection(
      downloadMangaNewsCsv("https://static.data.gouv.fr/x.csv", {
        fetch: async () => new Response("", { status: 404 }),
      }),
      UpstreamError,
    );
    expect(missing.kind).toBe("not_found");
    const down = await rejection(
      downloadMangaNewsCsv("https://static.data.gouv.fr/x.csv", {
        fetch: async () => {
          throw new TypeError("getaddrinfo ENOTFOUND");
        },
      }),
      UpstreamError,
    );
    expect(down.message).toBe("Could not download the Manga-News CSV from static.data.gouv.fr: getaddrinfo ENOTFOUND");
    const latin1 = await rejection(
      downloadMangaNewsCsv("https://x/y.csv", {
        fetch: async () => new Response(new Uint8Array([0x47, 0x6c, 0xe9, 0x6e, 0x61, 0x74])),
      }),
      UpstreamError,
    );
    expect(latin1.message).toContain("not UTF-8");
  });
});

describe("manga-news procedures", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const api = apiClient(db, { apiKey: ensureApiKey(db) });
    const fr = db
      .insert(languages)
      .values({ code: "fr", name: "French", rootFolder: normalizePath(join(root, "fr")), useMangaNewsDataset: true })
      .returning()
      .get();
    const serve = (body: string) =>
      spyOn(globalThis, "fetch").mockImplementation(
        (async () => new Response(body)) as unknown as typeof globalThis.fetch,
      );
    return { db, api, fr, serve };
  }

  it("starts empty, with data.gouv.fr's latest-file link as the CSV URL", async () => {
    const { api } = setup();
    expect(await api.mangaNews.status()).toEqual({ rowCount: 0, importedAt: null });
    expect((await api.settings.get()).mangaNewsCsvUrl).toStartWith("https://www.data.gouv.fr/api/1/datasets/r/");
    expect(await errorCode(api.mangaNews.search({ query: "berserk" }))).toBe("PRECONDITION_FAILED");
  });

  it("refreshes from the saved URL and searches", async () => {
    const { api, db, serve } = setup();
    setSetting(db, "mangaNewsCsvUrl", "https://example.test/series.csv");
    const fetch = serve(csv);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const result = await api.mangaNews.refresh();
    log.mockRestore();
    expect(result).toMatchObject({ rowCount: 13, added: 13, removed: 0 });
    expect((fetch.mock.calls[0]![0] as Request).url).toBe("https://example.test/series.csv");
    expect(await api.mangaNews.status()).toMatchObject({ rowCount: 13 });

    const [envol] = await api.mangaNews.search({ query: "envol", limit: 1 });
    expect(envol).toMatchObject({ title: "Envol (l')", displayTitle: "L'Envol", volumeCount: 1 });
    expect(envol).not.toHaveProperty("searchTitle");
  });

  it("keeps the dataset when the download is not the CSV", async () => {
    const { api, serve } = setup();
    serve(csv);
    spyOn(console, "log").mockImplementation(() => {});
    await api.mangaNews.refresh();
    (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
    serve("<html>maintenance</html>");
    expect(await errorCode(api.mangaNews.refresh())).toBe("BAD_GATEWAY");
    expect(await api.mangaNews.status()).toMatchObject({ rowCount: 13 });
  });

  it("links a row when adding a series: its count and publisher win over MangaBaka's", async () => {
    const { api, db, fr } = setup();
    storeMangaNewsDataset(db, parseMangaNewsCsv(csv));
    const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: fr.id });
    const base = {
      languageId: fr.id,
      mangabakaId: draft.mangabakaId,
      displayTitle: "Blue Lock",
      searchTerms: ["Blue Lock"],
    };

    expect(await errorCode(api.series.create({ ...base, mangaNewsSeriesId: 1 }))).toBe("BAD_REQUEST");

    const created = await api.series.create({ ...base, mangaNewsSeriesId: 27713 });
    expect(created).toMatchObject({
      mangaNewsSeriesId: 27713,
      publisher: "Pika",
      volumeCount: 33,
      volumeCountSource: "manganews",
    });
    expect(created.mangaNews).toMatchObject({ id: 27713, title: "Blue Lock", volumeCount: 33 });
  });

  it("keeps a count given with the link as manual, unless it is the row's", async () => {
    const { api, db, fr } = setup();
    storeMangaNewsDataset(db, parseMangaNewsCsv(csv));
    const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: fr.id });
    const created = await api.series.create({
      languageId: fr.id,
      mangabakaId: draft.mangabakaId,
      displayTitle: "Blue Lock",
      searchTerms: ["Blue Lock"],
      volumeCount: 20,
      mangaNewsSeriesId: 27713,
    });
    expect(created).toMatchObject({ volumeCount: 20, volumeCountSource: "manual", publisher: "Pika" });

    // Linking again later with no count takes the row's.
    expect(await api.series.update({ id: created.id, mangaNewsSeriesId: 27713 })).toMatchObject({
      volumeCount: 33,
      volumeCountSource: "manganews",
    });
    expect(await api.series.update({ id: created.id, volumeCount: 33, mangaNewsSeriesId: 27713 })).toMatchObject({
      volumeCountSource: "manganews",
    });
  });

  it("links, relinks and unlinks an existing series; unlinking keeps the values", async () => {
    const { api, db, fr } = setup();
    storeMangaNewsDataset(db, parseMangaNewsCsv(csv));
    const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: fr.id });
    const created = await api.series.create({
      languageId: fr.id,
      mangabakaId: draft.mangabakaId,
      displayTitle: "Blue Lock",
      searchTerms: ["Blue Lock"],
    });
    expect(created.mangaNews).toBeNull();

    // A row announcing a series (0 volumes) sets the publisher but not the count.
    const announced = await api.series.update({ id: created.id, mangaNewsSeriesId: 34056 });
    expect(announced).toMatchObject({
      mangaNewsSeriesId: 34056,
      publisher: "Piccoma",
      volumeCount: created.volumeCount,
      volumeCountSource: created.volumeCountSource,
    });

    await api.series.update({ id: created.id, mangaNewsSeriesId: 27713 });
    const unlinked = await api.series.update({ id: created.id, mangaNewsSeriesId: null });
    expect(unlinked).toMatchObject({
      mangaNewsSeriesId: null,
      mangaNews: null,
      publisher: "Pika",
      volumeCount: 33,
      volumeCountSource: "manual",
    });
  });

  it("keeps a linked series' publisher on a MangaBaka refresh", async () => {
    const { api, db, fr } = setup();
    storeMangaNewsDataset(db, parseMangaNewsCsv(csv));
    const draft = await api.series.draft({ mangabakaId: recorded.blueLock, languageId: fr.id });
    const created = await api.series.create({
      languageId: fr.id,
      mangabakaId: draft.mangabakaId,
      displayTitle: "Blue Lock",
      searchTerms: ["Blue Lock"],
      mangaNewsSeriesId: 27713,
    });
    expect(await api.series.refreshMetadata({ id: created.id })).toMatchObject({
      publisher: "Pika",
      volumeCount: 33,
      volumeCountSource: "manganews",
    });
  });
});
