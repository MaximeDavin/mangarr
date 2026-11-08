// Import (spec §7.4), the poller around it, and the Activity procedures, with a fake qBittorrent
// and real files in a temporary folder.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client";
import { downloads, importLogEntries, languages, series, volumes } from "../src/db/schema";
import { createKomgaClient } from "../src/integrations/komga";
import { createQBittorrentClient } from "../src/integrations/qbittorrent";
import { createPoller } from "../src/jobs/poller";
import { copyStrategy, DestinationExists, importDownload } from "../src/library/import";
import { normalizePath, volumeFileName, volumePadding } from "../src/library/paths";
import { ensureApiKey, setSetting } from "../src/settings";
import { type FakeTorrent, fakeQBittorrent } from "./fake-qbittorrent";
import { apiClient, rejection } from "./helpers";

let temp: string;
let torrents: string;
let library: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "mangarr-import-"));
  torrents = normalizePath(join(temp, "torrents"));
  library = normalizePath(join(temp, "library"));
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const hash = "a".repeat(40);
const seriesFolder = () => `${library}/Berserk`;

function setup({ volumeCount = 42 as number | null, expectedVolumes = [] as number[], status = "importing" as const } = {}) {
  const db = openDatabase(":memory:");
  const qbit = fakeQBittorrent();
  const client = createQBittorrentClient({ url: qbit.url, username: qbit.username, password: qbit.password, fetch: qbit.fetch });
  const language = db.insert(languages).values({ code: "en", name: "English", rootFolder: library }).returning().get();
  const target = db
    .insert(series)
    .values({ languageId: language.id, mangabakaId: 1, displayTitle: "Berserk", folderPath: seriesFolder(), volumeCount })
    .returning()
    .get();
  const download = db
    .insert(downloads)
    .values({
      seriesId: target.id,
      infoHash: hash,
      releaseTitle: "Berserk (test)",
      indexerName: "Nyaa",
      prowlarrGuid: "g1",
      size: 1,
      expectedVolumes,
      titleMatch: "exact",
      status,
    })
    .returning()
    .get();
  return { db, qbit, client, seriesId: target.id, downloadId: download.id };
}

/** A finished torrent in qBittorrent, with these files on disk (content = the file name). */
function seed(qbit: ReturnType<typeof fakeQBittorrent>, names: string[], torrent: Partial<FakeTorrent> = {}) {
  for (const name of names) {
    const path = join(torrents, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, name);
  }
  qbit.state.torrents.push({
    hash,
    name: "Berserk",
    category: "mangarr",
    state: "uploading",
    progress: 1,
    amount_left: 0,
    save_path: torrents,
    ...torrent,
  });
  qbit.state.files.set(hash, names.map((name) => ({ name, size: name.length, progress: 1, priority: 1 })));
}

function libraryFiles() {
  return existsSync(seriesFolder()) ? readdirSync(seriesFolder()).sort() : [];
}

function owned(file: string) {
  mkdirSync(seriesFolder(), { recursive: true });
  writeFileSync(join(seriesFolder(), file), "already here");
}

const logOf = (db: ReturnType<typeof setup>["db"], downloadId: number) =>
  db
    .select()
    .from(importLogEntries)
    .where(eq(importLogEntries.downloadId, downloadId))
    .all()
    .map((e) => [e.sourceFile, e.action, e.volumeNumber]);

const statusOf = (db: ReturnType<typeof setup>["db"], downloadId: number) =>
  db.select({ status: downloads.status, message: downloads.statusMessage }).from(downloads).where(eq(downloads.id, downloadId)).get();

describe("naming", () => {
  it("pads to 2 digits, or 3 from volume 100, and keeps decimals", () => {
    expect(volumeFileName("Berserk", 7, "cbz", 2)).toBe("Berserk v07.cbz");
    expect(volumeFileName("Berserk", 10.5, "cbz", 2)).toBe("Berserk v10.5.cbz");
    expect(volumeFileName("Re:Zero", 5.5, "cbr", 3)).toBe("Re - Zero v005.5.cbr");
    expect(volumePadding(42, [1, 2])).toBe(2);
    expect(volumePadding(105, [])).toBe(3);
    expect(volumePadding(null, [100])).toBe(3);
  });
});

describe("copyStrategy", () => {
  it("never replaces a file and leaves no temporary file behind", async () => {
    mkdirSync(join(temp, "dest"));
    const source = normalizePath(join(temp, "source.cbz"));
    const dest = normalizePath(join(temp, "dest", "Berserk v01.cbz"));
    writeFileSync(source, "new");
    writeFileSync(dest, "old");
    expect(await rejection(copyStrategy.place(source, dest), DestinationExists)).toBeInstanceOf(DestinationExists);
    expect(readFileSync(dest, "utf8")).toBe("old");
    expect(readdirSync(join(temp, "dest"))).toEqual(["Berserk v01.cbz"]);
  });
});

describe("importDownload", () => {
  it("copies volumes with clean names and logs every file", async () => {
    const { db, qbit, client, seriesId, downloadId } = setup();
    seed(qbit, [
      "Berserk (01-03)/Berserk v01 (Digital).cbz",
      "Berserk (01-03)/Berserk v02 (Digital).zip",
      "Berserk (01-03)/Berserk v03 (Digital).CBR",
      "Berserk (01-03)/cover.jpg",
      "Berserk (01-03)/Berserk c377.cbz",
      "Berserk (01-03)/Berserk v04-05.cbz",
    ]);

    const result = await importDownload(db, downloadId, client);
    expect(result).toEqual({ status: "imported", imported: 3 });
    expect(libraryFiles()).toEqual(["Berserk v01.cbz", "Berserk v02.cbz", "Berserk v03.cbr"]);
    expect(readFileSync(join(seriesFolder(), "Berserk v02.cbz"), "utf8")).toBe("Berserk (01-03)/Berserk v02 (Digital).zip");
    // The torrent's files stay where they are.
    expect(existsSync(join(torrents, "Berserk (01-03)/Berserk v01 (Digital).cbz"))).toBe(true);

    // In the torrent's file order.
    expect(logOf(db, downloadId)).toEqual([
      ["Berserk (01-03)/Berserk c377.cbz", "skipped_unparseable", null],
      ["Berserk (01-03)/Berserk v01 (Digital).cbz", "imported", 1],
      ["Berserk (01-03)/Berserk v02 (Digital).zip", "imported", 2],
      ["Berserk (01-03)/Berserk v03 (Digital).CBR", "imported", 3],
      ["Berserk (01-03)/Berserk v04-05.cbz", "skipped_unparseable", null],
      ["Berserk (01-03)/cover.jpg", "skipped_format", null],
    ]);
    expect(statusOf(db, downloadId)).toEqual({ status: "imported", message: null });
    const rows = db.select({ number: volumes.number, source: volumes.source, format: volumes.format }).from(volumes).where(eq(volumes.seriesId, seriesId)).all();
    expect(rows.sort((a, b) => a.number - b.number)).toEqual([
      { number: 1, source: "import", format: "cbz" },
      { number: 2, source: "import", format: "cbz" },
      { number: 3, source: "import", format: "cbr" },
    ]);
  });

  it("keeps volumes already on disk and imports the rest", async () => {
    const { db, qbit, client, downloadId } = setup();
    owned("Berserk v01.cbz");
    seed(qbit, ["Berserk v01.cbz", "Berserk v02.cbz"]);
    expect(await importDownload(db, downloadId, client)).toMatchObject({ status: "imported", imported: 1 });
    expect(readFileSync(join(seriesFolder(), "Berserk v01.cbz"), "utf8")).toBe("already here");
    expect(logOf(db, downloadId)).toEqual([
      ["Berserk v01.cbz", "skipped_owned", 1],
      ["Berserk v02.cbz", "imported", 2],
    ]);
  });

  it("needs attention when every volume is already owned", async () => {
    const { db, qbit, client, downloadId } = setup();
    owned("Berserk v01.cbz");
    seed(qbit, ["Berserk v01.cbz", "notes.txt"]);
    expect(await importDownload(db, downloadId, client)).toEqual({
      status: "needs_attention",
      message: "Every volume in the torrent is already owned",
      imported: 0,
    });
  });

  it("gives a lone file with no number the release's single volume", async () => {
    const { db, qbit, client, downloadId } = setup({ expectedVolumes: [42] });
    seed(qbit, ["Berserk.cbz"]);
    await importDownload(db, downloadId, client);
    expect(libraryFiles()).toEqual(["Berserk v42.cbz"]);
  });

  it("pads to 3 digits for long series", async () => {
    const { db, qbit, client, downloadId } = setup({ volumeCount: 110 });
    seed(qbit, ["One Piece v105.cbz", "One Piece v01.cbz"]);
    await importDownload(db, downloadId, client);
    expect(libraryFiles()).toEqual(["Berserk v001.cbz", "Berserk v105.cbz"]);
  });

  it("needs attention when nothing can be imported", async () => {
    const formats = setup();
    seed(formats.qbit, ["Berserk v01.epub", "Berserk v01.pdf"]);
    expect((await importDownload(formats.db, formats.downloadId, formats.client)).message).toBe("No .cbz, .zip or .cbr files in the torrent");

    const gone = setup();
    expect((await importDownload(gone.db, gone.downloadId, gone.client)).message).toBe("The torrent is no longer in qBittorrent");
  });

  it("replaces the previous attempt's log", async () => {
    const { db, qbit, client, downloadId } = setup();
    seed(qbit, ["readme.txt"]);
    await importDownload(db, downloadId, client);
    qbit.state.files.set(hash, [{ name: "readme.txt", size: 1, progress: 1, priority: 1 }, { name: "Berserk v01.cbz", size: 1, progress: 1, priority: 1 }]);
    writeFileSync(join(torrents, "Berserk v01.cbz"), "x");
    await importDownload(db, downloadId, client);
    expect(logOf(db, downloadId)).toEqual([
      ["Berserk v01.cbz", "imported", 1],
      ["readme.txt", "skipped_format", null],
    ]);
  });
});

describe("poller", () => {
  const poller = (s: ReturnType<typeof setup>) => createPoller(s.db, { qbittorrent: () => s.client, intervalMs: () => 60_000 });

  it("imports a download as soon as qBittorrent reports it complete", async () => {
    const s = setup({ status: "downloading" as never });
    seed(s.qbit, ["Berserk v01.cbz"], { state: "downloading", progress: 0.4, amount_left: 10 });
    await poller(s).tick();
    expect(statusOf(s.db, s.downloadId)?.status).toBe("downloading");

    Object.assign(s.qbit.state.torrents[0]!, { state: "stalledUP", progress: 1, amount_left: 0 });
    await poller(s).tick();
    expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
    expect(libraryFiles()).toEqual(["Berserk v01.cbz"]);
  });

  it("does not take a magnet still fetching its metadata, or a torrent being checked, as complete", async () => {
    const s = setup({ status: "downloading" as never });
    seed(s.qbit, [], { state: "metaDL", progress: 0, amount_left: 0 });
    await poller(s).tick();
    Object.assign(s.qbit.state.torrents[0]!, { state: "checkingUP", progress: 1 });
    await poller(s).tick();
    expect(statusOf(s.db, s.downloadId)?.status).toBe("downloading");
  });

  it("marks a torrent removed from qBittorrent, and recovers when it comes back", async () => {
    const s = setup({ status: "downloading" as never });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    await poller(s).tick();
    expect(statusOf(s.db, s.downloadId)).toMatchObject({ status: "missing_from_client" });
    seed(s.qbit, [], { state: "downloading", progress: 0.1, amount_left: 5 });
    await poller(s).tick();
    expect(statusOf(s.db, s.downloadId)).toEqual({ status: "downloading", message: null });
    warn.mockRestore();
  });

  it("keeps a download importing while qBittorrent fails, and imports it on a later tick", async () => {
    const s = setup();
    seed(s.qbit, ["Berserk v01.cbz"]);
    s.qbit.state.failWith = 500;
    expect((await rejection(poller(s).tick(), Error)).message).toContain("qBittorrent answered 500");
    expect(statusOf(s.db, s.downloadId)?.status).toBe("importing");
    s.qbit.state.failWith = undefined;
    await poller(s).tick();
    expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
  });

  describe("Komga scan", () => {
    /** Answers scans with 202, or with `status` when given, and records them. */
    function komga(status = 202) {
      const scans: string[] = [];
      const client = createKomgaClient({
        url: "http://komga:25600",
        apiKey: "key",
        fetch: async (request) => {
          scans.push(`${request.method} ${new URL(request.url).pathname}`);
          return new Response(status === 202 ? null : JSON.stringify({ message: "nope" }), { status });
        },
      });
      return { scans, client };
    }
    const withLibrary = (s: ReturnType<typeof setup>, libraryId: string | null) => s.db.update(languages).set({ komgaLibraryId: libraryId }).run();

    it("scans the language's library once after volumes are imported", async () => {
      const s = setup();
      withLibrary(s, "0LIB");
      seed(s.qbit, ["Berserk v01.cbz", "Berserk v02.cbz"]);
      const k = komga();
      await createPoller(s.db, { qbittorrent: () => s.client, komga: () => k.client }).tick();
      expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
      expect(k.scans).toEqual(["POST /api/v1/libraries/0LIB/scan"]);
    });

    it("is skipped when nothing was imported, or the language has no library", async () => {
      const s = setup();
      withLibrary(s, "0LIB");
      owned("Berserk v01.cbz");
      seed(s.qbit, ["Berserk v01.cbz"]);
      const k = komga();
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      await createPoller(s.db, { qbittorrent: () => s.client, komga: () => k.client }).tick();
      expect(statusOf(s.db, s.downloadId)?.status).toBe("needs_attention");

      withLibrary(s, null);
      rmSync(join(seriesFolder(), "Berserk v01.cbz"));
      s.db.update(downloads).set({ status: "importing" }).run();
      await createPoller(s.db, { qbittorrent: () => s.client, komga: () => k.client }).tick();
      expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
      expect(k.scans).toEqual([]);
      warn.mockRestore();
    });

    it("is skipped when Komga isn't set up", async () => {
      const s = setup();
      withLibrary(s, "0LIB");
      seed(s.qbit, ["Berserk v01.cbz"]);
      // The default client, from settings with no Komga URL.
      await createPoller(s.db, { qbittorrent: () => s.client }).tick();
      expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
    });

    it("only warns when Komga fails: the import stands, and the language keeps the error until a scan works", async () => {
      const s = setup();
      withLibrary(s, "0LIB");
      seed(s.qbit, ["Berserk v01.cbz"]);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      await createPoller(s.db, { qbittorrent: () => s.client, komga: () => komga(404).client }).tick();
      expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
      expect(warn.mock.calls.flat().join(" ")).toContain("Komga has no library 0LIB");
      warn.mockRestore();
      const language = () => s.db.select().from(languages).get()!;
      expect(language()).toMatchObject({ komgaScanError: "Komga has no library 0LIB", komgaScanErrorAt: expect.any(Date) });

      // The next import's scan works.
      rmSync(join(seriesFolder(), "Berserk v01.cbz"));
      s.db.update(downloads).set({ status: "importing" }).run();
      await createPoller(s.db, { qbittorrent: () => s.client, komga: () => komga().client }).tick();
      expect(language()).toMatchObject({ komgaScanError: null, komgaScanErrorAt: null });
    });
  });

  it("does nothing until qBittorrent is set up", async () => {
    const db = openDatabase(":memory:");
    await createPoller(db).tick();
  });

  it("runs a tick when woken", async () => {
    const s = setup();
    seed(s.qbit, ["Berserk v01.cbz"]);
    const p = poller(s);
    p.start();
    await Bun.sleep(50);
    expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
    s.db.update(downloads).set({ status: "importing" }).run();
    rmSync(join(seriesFolder(), "Berserk v01.cbz"));
    p.wake();
    await Bun.sleep(50);
    p.stop();
    expect(statusOf(s.db, s.downloadId)?.status).toBe("imported");
    expect(libraryFiles()).toEqual(["Berserk v01.cbz"]);
  });
});

describe("downloads procedures", () => {
  function api(s: ReturnType<typeof setup>, wakes: string[] = []) {
    spyOn(globalThis, "fetch").mockImplementation(s.qbit.fetch as unknown as typeof fetch);
    setSetting(s.db, "qbittorrentUrl", s.qbit.url);
    setSetting(s.db, "qbittorrentUsername", s.qbit.username);
    setSetting(s.db, "qbittorrentPassword", s.qbit.password);
    return apiClient(s.db, { apiKey: ensureApiKey(s.db), jobs: { wake: () => wakes.push("wake") } });
  }

  it("lists downloads with qBittorrent's live progress", async () => {
    const s = setup({ status: "downloading" as never });
    seed(s.qbit, [], { state: "downloading", progress: 0.25, amount_left: 30, eta: 120, dlspeed: 2048 });
    const out = await api(s).downloads.list({});
    expect(out.clientError).toBeNull();
    expect(out.downloads[0]).toMatchObject({
      status: "downloading",
      series: { displayTitle: "Berserk" },
      client: { state: "downloading", progress: 0.25, eta: 120, downloadSpeed: 2048 },
    });
  });

  it("still lists downloads when qBittorrent is down", async () => {
    const s = setup({ status: "downloading" as never });
    const client = api(s);
    s.qbit.state.failWith = 500;
    const out = await client.downloads.list({});
    expect(out.clientError).toContain("500");
    expect(out.downloads[0]!.client).toBeNull();
  });

  it("filters by status, sorts by import date and pages with a total", async () => {
    const s = setup({ status: "imported" as never });
    const grab = (n: number, status: "imported" | "needs_attention", importedAt: Date | null) =>
      s.db
        .insert(downloads)
        .values({
          seriesId: s.seriesId,
          infoHash: String(n).repeat(40),
          releaseTitle: `Berserk ${n}`,
          indexerName: "Nyaa",
          prowlarrGuid: `g${n + 1}`,
          size: 1,
          expectedVolumes: [],
          titleMatch: "exact",
          status,
          importedAt,
        })
        .returning()
        .get().id;
    s.db.update(downloads).set({ importedAt: new Date(2_000) }).where(eq(downloads.id, s.downloadId)).run();
    const newest = grab(2, "imported", new Date(3_000));
    const oldest = grab(3, "imported", new Date(1_000));
    grab(4, "needs_attention", null);
    const client = api(s);

    const first = await client.downloads.list({ statuses: ["imported"], sort: "imported", limit: 2 });
    expect(first.total).toBe(3);
    expect(first.downloads.map((d) => d.id)).toEqual([newest, s.downloadId]);
    const second = await client.downloads.list({ statuses: ["imported"], sort: "imported", limit: 2, offset: 2 });
    expect(second.downloads.map((d) => d.id)).toEqual([oldest]);

    const active = await client.downloads.list({ statuses: ["needs_attention", "downloading"] });
    expect(active.total).toBe(1);
    expect(active.downloads[0]!.status).toBe("needs_attention");
  });

  it("shows one download with its import log", async () => {
    const s = setup();
    seed(s.qbit, ["Berserk v01.cbz", "x.txt"]);
    await importDownload(s.db, s.downloadId, s.client);
    const out = await api(s).downloads.get({ id: s.downloadId });
    expect(out.status).toBe("imported");
    expect(out.importLog.map((e) => e.action)).toEqual(["imported", "skipped_format"]);
  });

  it("retries an import that needs attention, and only that", async () => {
    const s = setup();
    const wakes: string[] = [];
    const client = api(s, wakes);
    expect((await rejection(client.downloads.retryImport({ id: s.downloadId }))).code).toBe("CONFLICT");

    s.db.update(downloads).set({ status: "needs_attention", statusMessage: "Every volume in the torrent is already owned" }).run();
    expect(await client.downloads.retryImport({ id: s.downloadId })).toMatchObject({ status: "importing", statusMessage: null });
    expect(wakes).toEqual(["wake"]);
    expect((await rejection(client.downloads.retryImport({ id: 999 }))).code).toBe("NOT_FOUND");
  });
});
