// The in-process job loop (spec §3, §7.4). Every poll interval:
//   1. ask qBittorrent about every tracked download and move finished ones to `importing`;
//   2. import every `importing` download, one at a time;
//   3. ask Komga to scan each library that got new volumes (spec §6.3).
// A download left `importing` by a crash is simply imported on the next tick.

import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { downloads, languages, series } from "../db/schema";
import { errorMessage } from "../errors";
import { type KomgaClient, komgaFromSettings } from "../integrations/komga";
import { isComplete, type QBittorrentClient, qbittorrentFromSettings } from "../integrations/qbittorrent";
import { UpstreamError } from "../integrations/upstream";
import { copyStrategy, type ImportStrategy, importDownload } from "../library/import";
import { getSetting } from "../settings";

export interface PollerOptions {
  /** Defaults to the client from the saved settings. */
  qbittorrent?: () => QBittorrentClient;
  /** Defaults to the client from the saved settings. */
  komga?: () => KomgaClient;
  strategy?: ImportStrategy;
  /** Defaults to the saved poll interval. */
  intervalMs?: () => number;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Runs a tick now (or right after the current one), e.g. after "Retry import". */
  wake(): void;
  /** One tick. Exposed for tests. */
  tick(): Promise<void>;
}


export function createPoller(db: Db, options: PollerOptions = {}): Poller {
  const client = options.qbittorrent ?? (() => qbittorrentFromSettings(db).client);
  const komga = options.komga ?? (() => komgaFromSettings(db));
  const strategy = options.strategy ?? copyStrategy;
  const intervalMs = options.intervalMs ?? (() => getSetting(db, "pollIntervalSeconds") * 1000);

  const setStatus = (id: number, set: Partial<typeof downloads.$inferInsert>) =>
    db.update(downloads).set(set).where(eq(downloads.id, id)).run();

  /** Step 1: what qBittorrent says about the downloads being watched. */
  async function watch(qbittorrent: QBittorrentClient) {
    const watched = db
      .select()
      .from(downloads)
      .where(inArray(downloads.status, ["downloading", "missing_from_client"]))
      .all();
    if (watched.length === 0) return;

    // By hash rather than by category: a torrent moved to another category is still found.
    const torrents = new Map((await qbittorrent.torrents({ hashes: watched.map((d) => d.infoHash) })).map((t) => [t.hash, t]));
    for (const download of watched) {
      const torrent = torrents.get(download.infoHash);
      if (!torrent) {
        if (download.status === "downloading") {
          setStatus(download.id, { status: "missing_from_client", statusMessage: "The torrent was removed from qBittorrent before it was imported" });
          console.warn(`poller: "${download.releaseTitle}" is no longer in qBittorrent`);
        }
        continue;
      }
      if (isComplete(torrent)) {
        setStatus(download.id, { status: "importing", statusMessage: null, completedAt: new Date() });
      } else if (download.status === "missing_from_client") {
        // Back in qBittorrent (re-added, or not listed yet right after the grab).
        setStatus(download.id, { status: "downloading", statusMessage: null });
      }
    }
  }

  /** Step 2: imports, oldest first, one at a time. Adds the series that got new volumes to `imported`. */
  async function importAll(qbittorrent: QBittorrentClient, imported: Set<number>) {
    const queue = db
      .select({ id: downloads.id, seriesId: downloads.seriesId, releaseTitle: downloads.releaseTitle })
      .from(downloads)
      .where(eq(downloads.status, "importing"))
      .orderBy(asc(downloads.completedAt), asc(downloads.id))
      .all();
    for (const { id, seriesId, releaseTitle } of queue) {
      try {
        const result = await importDownload(db, id, qbittorrent, strategy);
        if (result.status === "imported") {
          imported.add(seriesId);
          console.log(`import: "${releaseTitle}": ${result.imported} volume(s) imported`);
        } else console.warn(`import: "${releaseTitle}" needs attention: ${result.message}`);
      } catch (error) {
        // qBittorrent is unreachable or failing: stay `importing` and try again next tick.
        if (error instanceof UpstreamError) throw error;
        console.error(`import: "${releaseTitle}" failed:`, error);
        setStatus(id, { status: "needs_attention", statusMessage: `Import failed: ${errorMessage(error)}` });
      }
    }
  }

  /**
   * Step 3: one scan per Komga library, however many series in it got volumes. Skipped when Komga
   * isn't set up or the language has no library. A failure is a warning: the import stands.
   */
  async function scanKomga(seriesIds: Set<number>) {
    if (seriesIds.size === 0) return;
    const libraryIds = new Set(
      db
        .select({ libraryId: languages.komgaLibraryId })
        .from(series)
        .innerJoin(languages, eq(languages.id, series.languageId))
        .where(inArray(series.id, [...seriesIds]))
        .all()
        .flatMap(({ libraryId }) => (libraryId ? [libraryId] : [])),
    );
    if (libraryIds.size === 0) return;

    let client: KomgaClient;
    try {
      client = komga();
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === "not_configured") return;
      throw error;
    }
    // Kept on the languages using the library, so Settings can show it (there is no logs page).
    const remember = (libraryId: string, error: string | null) =>
      db
        .update(languages)
        .set({ komgaScanError: error, komgaScanErrorAt: error === null ? null : new Date() })
        .where(eq(languages.komgaLibraryId, libraryId))
        .run();
    for (const libraryId of libraryIds) {
      try {
        await client.scanLibrary(libraryId);
        remember(libraryId, null);
        console.log(`komga: scan of library ${libraryId} requested`);
      } catch (error) {
        remember(libraryId, errorMessage(error));
        console.warn(`komga: could not scan library ${libraryId}: ${errorMessage(error)}`);
      }
    }
  }

  async function tick() {
    let qbittorrent: QBittorrentClient;
    try {
      qbittorrent = client();
    } catch (error) {
      // Nothing to poll until qBittorrent is set up.
      if (error instanceof UpstreamError && error.kind === "not_configured") return;
      throw error;
    }
    await watch(qbittorrent);
    const imported = new Set<number>();
    try {
      await importAll(qbittorrent, imported);
    } finally {
      // Volumes imported before qBittorrent failed mid-queue still get their scan.
      await scanKomga(imported);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let stopped = true;
  /** Logged once until it changes, not every tick. */
  let lastWarning: string | undefined;

  async function run() {
    running = true;
    do {
      again = false;
      try {
        await tick();
        lastWarning = undefined;
      } catch (error) {
        const message = errorMessage(error);
        if (message !== lastWarning) console.warn(`poller: ${message}`);
        lastWarning = message;
      }
    } while (again && !stopped);
    running = false;
  }

  function loop() {
    timer = undefined;
    void run().then(() => {
      if (!stopped) timer = setTimeout(loop, intervalMs());
    });
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      loop();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
    wake() {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      clearTimeout(timer);
      loop();
    },
  };
}
