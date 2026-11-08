// Disk scan (spec §7.5): the filesystem decides which volumes a series owns.
// Lists the .cbz and .cbr files directly in the series folder, reads each name with the release
// parser, and replaces the series' Volume rows. Files it can't use become warnings.

import { readdir, stat } from "node:fs/promises";
import { parseRelease } from "@mangarr/release-parser";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type ScanWarning, series, volumeFormats, volumes } from "../db/schema";
import { errorMessage } from "../errors";
import { joinPath } from "./paths";

type Format = (typeof volumeFormats)[number];
const isFormat = (ext: string | undefined): ext is Format => volumeFormats.includes(ext as Format);

export interface ScannedVolume {
  number: number;
  filePath: string;
  fileSize: number;
  format: Format;
}

export interface FolderScan {
  /** False when the folder doesn't exist yet: the first import creates it. Not a warning. */
  folderExists: boolean;
  /** Sorted by number. */
  volumes: ScannedVolume[];
  warnings: ScanWarning[];
}

/** Reads a series folder. Never throws for filesystem problems: they become warnings. */
export async function scanFolder(folder: string): Promise<FolderScan> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "ENOENT") return { folderExists: false, volumes: [], warnings: [] };
    if (code === "ENOTDIR") {
      return { folderExists: true, volumes: [], warnings: [{ message: "The series path is a file, not a folder" }] };
    }
    return {
      folderExists: true,
      volumes: [],
      warnings: [{ message: `Could not read the folder: ${errorMessage(error)}` }],
    };
  }

  // Plain code-unit order, so which duplicate wins doesn't depend on the locale.
  const candidates = names
    .sort()
    .map((name) => ({ name, parsed: parseRelease(name), filePath: joinPath(folder, name) }))
    .filter((c) => isFormat(c.parsed.extension));
  const stats = await Promise.allSettled(candidates.map((c) => stat(c.filePath)));

  const found: ScannedVolume[] = [];
  const warnings: ScanWarning[] = [];
  /** Volume number → the file that has it. */
  const owner = new Map<number, string>();

  candidates.forEach(({ name, parsed, filePath }, i) => {
    const info = stats[i]!;
    if (info.status === "rejected") {
      warnings.push({ file: name, message: `Could not read the file: ${errorMessage(info.reason)}` });
      return;
    }
    // A folder named "Berserk v01.cbz": not a file we can use.
    if (!info.value.isFile()) return;

    const [first, ...rest] = parsed.volumes;
    if (parsed.isChapterRelease) {
      warnings.push({ file: name, message: "Looks like a chapter, not a volume" });
    } else if (first === undefined) {
      warnings.push({ file: name, message: "No volume number in the name" });
    } else if (rest.length > 0) {
      warnings.push({ file: name, message: `Covers volumes ${first}–${rest.at(-1)}; one file per volume is expected` });
    } else if (owner.has(first)) {
      warnings.push({ file: name, message: `Volume ${first} is already "${owner.get(first)}"; this file is ignored` });
    } else {
      owner.set(first, name);
      found.push({ number: first, filePath, fileSize: info.value.size, format: parsed.extension as Format });
    }
  });

  found.sort((a, b) => a.number - b.number);
  return { folderExists: true, volumes: found, warnings };
}

/**
 * Scans a series folder and replaces its Volume rows. A file that was already a row keeps its
 * `source`, so an imported volume stays `import` after later scans.
 */
export async function scanSeries(db: Db, seriesId: number): Promise<FolderScan> {
  const row = db.select({ folderPath: series.folderPath }).from(series).where(eq(series.id, seriesId)).get();
  if (!row) throw new Error(`Series ${seriesId} not found`);

  const scan = await scanFolder(row.folderPath);

  db.transaction((tx) => {
    const previous = new Map(
      tx
        .select({ filePath: volumes.filePath, source: volumes.source })
        .from(volumes)
        .where(eq(volumes.seriesId, seriesId))
        .all()
        .map((v) => [v.filePath, v.source]),
    );
    tx.delete(volumes).where(eq(volumes.seriesId, seriesId)).run();
    if (scan.volumes.length > 0) {
      tx.insert(volumes)
        .values(scan.volumes.map((v) => ({ ...v, seriesId, source: previous.get(v.filePath) ?? "scan" })))
        .run();
    }
    tx.update(series)
      .set({ lastScannedAt: new Date(), scanWarnings: scan.warnings })
      .where(eq(series.id, seriesId))
      .run();
  });

  return scan;
}

/** Scans every series, one at a time, as the server starts. A failure is logged and the next series goes on. */
export async function scanAllSeries(db: Db): Promise<void> {
  const all = db.select({ id: series.id, displayTitle: series.displayTitle }).from(series).all();
  for (const { id, displayTitle } of all) {
    try {
      await scanSeries(db, id);
    } catch (error) {
      console.error(`scan: could not scan "${displayTitle}" (series ${id}):`, error);
    }
  }
  if (all.length > 0) console.log(`scan: scanned ${all.length} series`);
}
