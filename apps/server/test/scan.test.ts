import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client";
import { languages, series, volumes } from "../src/db/schema";
import { isInside, joinPath, normalizePath, sanitizeName } from "../src/library/paths";
import { scanAllSeries, scanFolder, scanSeries } from "../src/library/scan";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mangarr-scan-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function files(folder: string, names: Record<string, string>) {
  mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(names)) writeFileSync(join(folder, name), content);
}

describe("scanFolder", () => {
  it("reads one volume per .cbz or .cbr file, sorted by number", async () => {
    files(dir, { "Berserk v10.5.cbz": "abc", "Berserk v02.CBR": "de", "Berserk v01.cbz": "f" });
    const scan = await scanFolder(dir);
    expect(scan.folderExists).toBe(true);
    expect(scan.warnings).toEqual([]);
    expect(scan.volumes).toEqual([
      { number: 1, filePath: joinPath(dir, "Berserk v01.cbz"), fileSize: 1, format: "cbz" },
      { number: 2, filePath: joinPath(dir, "Berserk v02.CBR"), fileSize: 2, format: "cbr" },
      { number: 10.5, filePath: joinPath(dir, "Berserk v10.5.cbz"), fileSize: 3, format: "cbz" },
    ]);
  });

  it("ignores other files and sub-folders, without warnings", async () => {
    files(dir, { "cover.jpg": "", "Berserk v01.epub": "", "notes.txt": "", "Berserk v03.cbz": "" });
    mkdirSync(join(dir, "Berserk v02.cbz"));
    mkdirSync(join(dir, "extras"));
    const scan = await scanFolder(dir);
    expect(scan.volumes.map((v) => v.number)).toEqual([3]);
    expect(scan.warnings).toEqual([]);
  });

  it("warns about files it can't turn into one volume", async () => {
    files(dir, {
      "Berserk c001.cbz": "",
      "Berserk.cbz": "",
      "Berserk v01-03.cbz": "",
      "Berserk v04.cbz": "",
    });
    const scan = await scanFolder(dir);
    expect(scan.volumes.map((v) => v.number)).toEqual([4]);
    expect(scan.warnings).toEqual([
      { file: "Berserk c001.cbz", message: "Looks like a chapter, not a volume" },
      { file: "Berserk v01-03.cbz", message: "Covers volumes 1–3; one file per volume is expected" },
      { file: "Berserk.cbz", message: "No volume number in the name" },
    ]);
  });

  it("keeps the first file of a duplicate volume number and warns about the others", async () => {
    files(dir, { "Berserk v01.cbz": "", "Berserk Vol. 1.cbr": "", "Berserk v1 (Digital).cbz": "" });
    const scan = await scanFolder(dir);
    expect(scan.volumes).toHaveLength(1);
    expect(scan.volumes[0]!.filePath).toBe(joinPath(dir, "Berserk Vol. 1.cbr"));
    expect(scan.warnings.map((w) => w.file)).toEqual(["Berserk v01.cbz", "Berserk v1 (Digital).cbz"]);
    expect(scan.warnings[0]!.message).toBe('Volume 1 is already "Berserk Vol. 1.cbr"; this file is ignored');
  });

  it("treats a missing folder as empty, not as a problem", async () => {
    expect(await scanFolder(join(dir, "nope"))).toEqual({ folderExists: false, volumes: [], warnings: [] });
  });

  it("warns when the path is a file", async () => {
    files(dir, { "Berserk": "" });
    const scan = await scanFolder(join(dir, "Berserk"));
    expect(scan.volumes).toEqual([]);
    expect(scan.warnings).toEqual([{ message: "The series path is a file, not a folder" }]);
  });
});

describe("scanSeries", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const lang = db.insert(languages).values({ code: "en", name: "English", rootFolder: dir }).returning().get();
    const add = (title: string) =>
      db
        .insert(series)
        .values({ languageId: lang.id, mangabakaId: title.length, displayTitle: title, folderPath: joinPath(dir, title) })
        .returning()
        .get();
    return { db, add };
  }

  it("replaces the series' volumes and saves the warnings", async () => {
    const { db, add } = setup();
    const berserk = add("Berserk");
    files(join(dir, "Berserk"), { "Berserk v01.cbz": "", "Berserk v02.cbz": "", "Berserk.cbz": "" });
    await scanSeries(db, berserk.id);

    rmSync(join(dir, "Berserk", "Berserk v02.cbz"));
    files(join(dir, "Berserk"), { "Berserk v03.cbz": "" });
    const scan = await scanSeries(db, berserk.id);

    expect(scan.volumes.map((v) => v.number)).toEqual([1, 3]);
    const rows = db.select().from(volumes).where(eq(volumes.seriesId, berserk.id)).orderBy(volumes.number).all();
    expect(rows.map((v) => [v.number, v.source])).toEqual([
      [1, "scan"],
      [3, "scan"],
    ]);
    const saved = db.select().from(series).where(eq(series.id, berserk.id)).get()!;
    expect(saved.scanWarnings).toEqual([{ file: "Berserk.cbz", message: "No volume number in the name" }]);
    expect(saved.lastScannedAt).toBeInstanceOf(Date);
  });

  it("keeps the source of files that were already rows", async () => {
    const { db, add } = setup();
    const berserk = add("Berserk");
    files(join(dir, "Berserk"), { "Berserk v01.cbz": "", "Berserk v02.cbz": "" });
    db.insert(volumes)
      .values({
        seriesId: berserk.id,
        number: 1,
        filePath: joinPath(berserk.folderPath, "Berserk v01.cbz"),
        fileSize: 0,
        format: "cbz",
        source: "import",
      })
      .run();
    await scanSeries(db, berserk.id);
    const rows = db.select().from(volumes).orderBy(volumes.number).all();
    expect(rows.map((v) => v.source)).toEqual(["import", "scan"]);
  });

  it("scans every series at startup, and a broken one doesn't stop the rest", async () => {
    const { db, add } = setup();
    const a = add("Berserk");
    const b = add("Akira");
    files(join(dir, "Berserk"), { "Berserk v01.cbz": "" });
    files(join(dir, "Akira"), { "Akira v01.cbz": "", "Akira v02.cbz": "" });
    await scanAllSeries(db);
    const count = (id: number) => db.select().from(volumes).where(eq(volumes.seriesId, id)).all().length;
    expect([count(a.id), count(b.id)]).toEqual([1, 2]);
  });
});

describe("sanitizeName", () => {
  it.each([
    ["Berserk", "Berserk"],
    ["Re:Zero", "Re - Zero"],
    ["Kaguya-sama: Love Is War", "Kaguya-sama - Love Is War"],
    ["Fate/stay night", "Fate-stay night"],
    ['What? "Really"*', "What Really"],
    ["Ending dots...", "Ending dots"],
    ["  Spaced \t out  ", "Spaced out"],
    ["???", ""],
  ])("%p → %p", (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });
});

describe("normalizePath", () => {
  it.each([
    ["/data/manga/en/", "/data/manga/en"],
    ["/data//manga///en", "/data/manga/en"],
    ["/", "/"],
    ["C:\\manga\\en\\", "C:/manga/en"],
    ["C:\\", "C:/"],
  ])("%p → %p", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("joins without touching the name", () => {
    expect(joinPath("/", "Berserk")).toBe("/Berserk");
    expect(joinPath("C:\\manga\\", "a\\b.cbz")).toBe("C:/manga/a\\b.cbz");
  });
});

describe("isInside", () => {
  it("is true only strictly inside the root", () => {
    expect(isInside("/data/manga/en", "/data/manga/en/Berserk")).toBe(true);
    expect(isInside("/data/manga/en/", "/data/manga/en/a/b")).toBe(true);
    expect(isInside("/data/manga/en", "/data/manga/en")).toBe(false);
    expect(isInside("/data/manga/en", "/data/manga/english/Berserk")).toBe(false);
    expect(isInside("/data/manga/en", "/data/manga/en/../fr/Berserk")).toBe(false);
  });
});
