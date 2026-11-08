// Import (spec §7.4 steps 3–7): copy the volume files of a finished download into the series
// folder with clean names, log what happened to each file, then rescan the folder.
// Existing files are never overwritten, and nothing is ever deleted outside mangarr's own temp files.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { parseRelease } from "@mangarr/release-parser";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { downloads, importLogEntries, volumes } from "../db/schema";
import { errorMessage } from "../errors";
import type { QBittorrentClient, QBittorrentFile } from "../integrations/qbittorrent";
import { joinPath, normalizePath, volumeFileName, volumePadding } from "./paths";
import { scanSeries } from "./scan";

/** How a file gets into the library. v1 adds hardlinking, falling back to copy. */
export interface ImportStrategy {
  readonly name: string;
  /** Puts `source` at `dest`. Fails with `DestinationExists` rather than replacing a file. */
  place(source: string, dest: string): Promise<void>;
}

export class DestinationExists extends Error {
  constructor(dest: string) {
    super(`${dest} already exists`);
    this.name = "DestinationExists";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Copies to a temporary name next to the destination, then renames: Komga never sees half a file. */
export const copyStrategy: ImportStrategy = {
  name: "copy",
  async place(source, dest) {
    if (await exists(dest)) throw new DestinationExists(dest);
    const slash = dest.lastIndexOf("/");
    const temp = `${dest.slice(0, slash + 1)}.${dest.slice(slash + 1)}.${randomBytes(4).toString("hex")}.mangarr-tmp`;
    try {
      await copyFile(source, temp, constants.COPYFILE_EXCL);
      if (await exists(dest)) throw new DestinationExists(dest);
      await rename(temp, dest);
    } finally {
      await rm(temp, { force: true });
    }
  },
};

/**
 * `copyStrategy`, reading the files under `from` (where qBittorrent says they are) from `to`
 * instead, e.g. `/data` → `D:/data` when qBittorrent runs in Docker.
 */
export function mappedCopyStrategy(from: string, to: string): ImportStrategy {
  const source = normalizePath(from);
  const target = normalizePath(to);
  return {
    name: "copy (mapped)",
    place: (path, dest) =>
      copyStrategy.place(
        path === source || path.startsWith(`${source}/`) ? target + path.slice(source.length) : path,
        dest,
      ),
  };
}

const supported = new Set(["cbz", "zip", "cbr"]);

/** The file name at the end of a torrent path. */
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const extensionOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/** The one volume a file name stands for, or why it doesn't stand for one. */
function volumeOf(name: string): { number: number } | { reason: string } {
  const parsed = parseRelease(name);
  if (parsed.isChapterRelease) return { reason: "Looks like a chapter, not a volume" };
  const [first, ...rest] = parsed.volumes;
  if (first === undefined) return { reason: "No volume number in the name" };
  if (rest.length > 0) return { reason: `Covers volumes ${first}–${rest.at(-1)}; one file per volume is expected` };
  return { number: first };
}

export interface ImportResult {
  status: "imported" | "needs_attention";
  message?: string;
  imported: number;
}

type LogEntry = Omit<typeof importLogEntries.$inferInsert, "downloadId" | "id" | "createdAt">;

/**
 * Imports one download that qBittorrent reports complete. The previous attempt's log is replaced.
 * qBittorrent failures are thrown, so the caller can retry later; everything else ends in
 * `imported` or `needs_attention`.
 */
export async function importDownload(
  db: Db,
  downloadId: number,
  qbittorrent: QBittorrentClient,
  strategy: ImportStrategy = copyStrategy,
): Promise<ImportResult> {
  const download = db.query.downloads.findFirst({ where: { id: downloadId }, with: { series: true } }).sync();
  if (!download) throw new Error(`Download ${downloadId} not found`);
  const target = download.series;

  const finish = (result: ImportResult, log: LogEntry[]): ImportResult => {
    db.transaction((tx) => {
      tx.delete(importLogEntries).where(eq(importLogEntries.downloadId, downloadId)).run();
      if (log.length > 0)
        tx.insert(importLogEntries)
          .values(log.map((entry) => ({ ...entry, downloadId })))
          .run();
      tx.update(downloads)
        .set({
          status: result.status,
          statusMessage: result.message ?? null,
          ...(result.status === "imported" ? { importedAt: new Date() } : {}),
        })
        .where(eq(downloads.id, downloadId))
        .run();
    });
    return result;
  };
  const attention = (message: string, log: LogEntry[] = []) =>
    finish({ status: "needs_attention", message, imported: 0 }, log);

  const [torrent] = await qbittorrent.torrents({ hashes: [download.infoHash] });
  if (!torrent) return attention("The torrent is no longer in qBittorrent");
  const files = (await qbittorrent.files(download.infoHash)).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (files.length === 0) return attention("qBittorrent lists no files for this torrent");

  /** Exactly one entry per file, at the file's index, so the log reads in file order. */
  const log: LogEntry[] = [];
  const candidates: { index: number; file: QBittorrentFile; format: "cbz" | "cbr" }[] = [];
  files.forEach((file, index) => {
    const extension = extensionOf(baseName(file.name));
    if (!supported.has(extension)) {
      log[index] = {
        sourceFile: file.name,
        action: "skipped_format",
        message: extension ? `.${extension} files are not imported` : "No extension",
      };
    } else if (file.priority === 0 || file.progress < 1) {
      log[index] = {
        sourceFile: file.name,
        action: "error",
        message: "Not downloaded: the file is skipped or incomplete in qBittorrent",
      };
    } else {
      candidates.push({ index, file, format: extension === "cbr" ? "cbr" : "cbz" });
    }
  });
  if (candidates.length === 0) {
    const allFormat = log.every((e) => e.action === "skipped_format");
    return attention(
      allFormat ? "No .cbz, .zip or .cbr files in the torrent" : "No volume file could be imported",
      log,
    );
  }

  // The filesystem decides what is owned (spec §1.2), so the folder is scanned first.
  await scanSeries(db, target.id);
  const owned = new Map(
    db
      .select({ number: volumes.number, filePath: volumes.filePath })
      .from(volumes)
      .where(eq(volumes.seriesId, target.id))
      .all()
      .map((v) => [v.number, v.filePath]),
  );

  // Step 4: a lone file with no number takes the release's single volume.
  const numbered = candidates.map((candidate) => ({ ...candidate, volume: volumeOf(baseName(candidate.file.name)) }));
  if (numbered.length === 1 && "reason" in numbered[0]!.volume && download.expectedVolumes.length === 1) {
    numbered[0]!.volume = { number: download.expectedVolumes[0]! };
  }

  const incoming = numbered.flatMap(({ volume }) => ("number" in volume ? [volume.number] : []));
  const padding = volumePadding(target.volumeCount, [...owned.keys(), ...incoming]);
  let imported = 0;

  for (const { index, file, format, volume } of numbered) {
    const sourceFile = file.name;
    if ("reason" in volume) {
      log[index] = { sourceFile, action: "skipped_unparseable", message: volume.reason };
      continue;
    }
    const { number } = volume;
    const existing = owned.get(number);
    if (existing) {
      log[index] = {
        sourceFile,
        action: "skipped_owned",
        volumeNumber: number,
        destPath: existing,
        message: `Volume ${number} is already owned`,
      };
      continue;
    }
    const dest = joinPath(target.folderPath, volumeFileName(target.displayTitle, number, format, padding));
    try {
      await mkdir(target.folderPath, { recursive: true });
      await strategy.place(joinPath(torrent.savePath, file.name), dest);
    } catch (error) {
      log[index] =
        error instanceof DestinationExists
          ? {
              sourceFile,
              action: "skipped_owned",
              volumeNumber: number,
              destPath: dest,
              message: "A file with that name is already in the series folder",
            }
          : { sourceFile, action: "error", volumeNumber: number, destPath: dest, message: errorMessage(error) };
      continue;
    }
    // The row is written now so the rescan keeps `source = import`.
    db.insert(volumes)
      .values({ seriesId: target.id, number, filePath: dest, fileSize: file.size, format, source: "import" })
      .run();
    owned.set(number, dest);
    imported++;
    log[index] = { sourceFile, action: "imported", volumeNumber: number, destPath: dest };
  }

  if (imported === 0) {
    const ownedAll = log.filter((e) => e.action !== "skipped_format").every((e) => e.action === "skipped_owned");
    return attention(
      ownedAll ? "Every volume in the torrent is already owned" : "No volume file could be imported",
      log,
    );
  }
  const result = finish({ status: "imported", imported }, log);
  await scanSeries(db, target.id);
  return result;
}
