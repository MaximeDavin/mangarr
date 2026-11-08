// Series folders in a language's root (spec §7.1): listing them, which ones series use, and
// which one to propose for a new series.

import { readdir, stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { series } from "../db/schema";
import { joinPath } from "./paths";
import { matchKey } from "./prefill";

export interface RootFolder {
  name: string;
  path: string;
}

/** The sub-folders directly in `root`, by name. Empty when the root doesn't exist yet. */
export async function listFolders(root: string): Promise<RootFolder[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: joinPath(root, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return [];
    throw error;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Folder path → the series of this language using it. */
export function usedFolders(db: Db, languageId: number): Map<string, number> {
  const rows = db
    .select({ id: series.id, path: series.folderPath })
    .from(series)
    .where(eq(series.languageId, languageId))
    .all();
  return new Map(rows.map((s) => [s.path, s.id]));
}

export interface ProposedFolder {
  path: string;
  from: "display_title" | "matching_name";
  exists: boolean;
}

/**
 * The folder for a new series: `<root>/<display title>` when it exists or when nothing better does,
 * otherwise an existing folder no series uses whose name reads as one of `names` ("Frieren" for
 * "Frieren: Beyond Journey's End"), in `names` order.
 */
export async function proposeFolder(
  root: string,
  folderName: string,
  names: readonly string[],
  used: ReadonlyMap<string, number>,
): Promise<ProposedFolder> {
  const path = joinPath(root, folderName);
  if (await isDirectory(path)) return { path, from: "display_title", exists: true };

  const byKey = new Map(
    (await listFolders(root)).filter((f) => !used.has(f.path)).map((f) => [matchKey(f.name), f.path]),
  );
  for (const name of names) {
    const match = byKey.get(matchKey(name));
    if (match) return { path: match, from: "matching_name", exists: true };
  }
  return { path, from: "display_title", exists: false };
}
