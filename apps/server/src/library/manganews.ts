// The Manga-News table (spec §4.7, §6.5, §7.1): replacing it from a fresh CSV, searching it by
// title, and the series fields a link sets.

import { normalizeTitle } from "@mangarr/release-parser";
import { and, count, eq, inArray, isNotNull, like, lt, max, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { mangaNewsSeries, series } from "../db/schema";
import type { MangaNewsRow, ParsedDataset } from "../integrations/manganews";

/** Manga-News files titles by their first real word: "Envol (l')", "Aventures de Tom Sawyer (les)". */
const trailingArticle = /^(.*\S)\s*\((l'|l’|le|la|les|un|une|des|the|a|an)\)\s*$/i;

/** "Envol (l')" → "L'Envol", "Aventures de Tom Sawyer (les)" → "Les Aventures de Tom Sawyer". */
export function mangaNewsDisplayTitle(title: string): string {
  const match = trailingArticle.exec(title);
  if (!match) return title;
  const [, rest, article] = match as unknown as [string, string, string];
  const capitalized = article.charAt(0).toUpperCase() + article.slice(1).toLowerCase();
  // An elided article joins the word, as typed: normalized, "L'Envol" is "lenvol", like a query for "l'envol".
  return /['’]$/.test(article) ? `${capitalized}${rest}` : `${capitalized} ${rest}`;
}

/** The display title, normalized. What search compares, on both sides. */
export const mangaNewsSearchTitle = (title: string): string => normalizeTitle(mangaNewsDisplayTitle(title));

export interface DatasetStatus {
  rowCount: number;
  importedAt: Date | null;
}

export function datasetStatus(db: Db): DatasetStatus {
  const row = db
    .select({ rowCount: count(), importedAt: max(mangaNewsSeries.datasetImportedAt) })
    .from(mangaNewsSeries)
    .get();
  return { rowCount: row?.rowCount ?? 0, importedAt: row?.importedAt ?? null };
}

export interface RefreshResult extends DatasetStatus {
  added: number;
  removed: number;
  /** Lines in the file that gave no usable row. */
  skipped: number;
  /** Linked series whose volume count changed. */
  seriesUpdated: number;
  /** Series whose row is gone from the new file, so their link was cleared. */
  seriesUnlinked: number;
}

/** Rows per INSERT: 11 columns each stays far below SQLite's 32,766 parameters. */
const chunkSize = 500;

/**
 * Replaces the table with a freshly parsed file, in one transaction. Rows keep their Manga-News id,
 * so series links survive. Linked series whose count came from Manga-News get the new count; series
 * linked to a row the file no longer has are unlinked, and their count becomes a manual one.
 */
export function storeMangaNewsDataset(db: Db, { rows, skipped }: ParsedDataset, at = new Date()): RefreshResult {
  if (rows.length === 0) throw new Error("The Manga-News file has no rows; the current dataset is kept");

  return db.transaction((tx) => {
    // Rows the file no longer has are the ones left with an older timestamp, so it must move forward.
    const previous = tx
      .select({ at: max(mangaNewsSeries.datasetImportedAt) })
      .from(mangaNewsSeries)
      .get()?.at;
    const now = previous && previous >= at ? new Date(previous.getTime() + 1) : at;
    const before = new Set(
      tx
        .select({ id: mangaNewsSeries.id })
        .from(mangaNewsSeries)
        .all()
        .map((r) => r.id),
    );
    const ids = new Set(rows.map((r) => r.id));

    for (let i = 0; i < rows.length; i += chunkSize) {
      const values = rows.slice(i, i + chunkSize).map((row: MangaNewsRow) => ({
        ...row,
        searchTitle: mangaNewsSearchTitle(row.title),
        datasetImportedAt: now,
      }));
      tx.insert(mangaNewsSeries)
        .values(values)
        .onConflictDoUpdate({
          target: mangaNewsSeries.id,
          set: {
            url: excluded("url"),
            title: excluded("title"),
            searchTitle: excluded("search_title"),
            publisher: excluded("publisher"),
            volumeCount: excluded("volume_count"),
            artists: excluded("artists"),
            writers: excluded("writers"),
            genres: excluded("genres"),
            coverUrl: excluded("cover_url"),
            datasetImportedAt: excluded("dataset_imported_at"),
          },
        })
        .run();
    }

    // Rows the new file doesn't have. Their series lose the link (ON DELETE SET NULL); a count
    // taken from Manga-News stays, as one entered by hand.
    const stale = [...before].filter((id) => !ids.has(id));
    let seriesUnlinked = 0;
    if (stale.length > 0) {
      // Every row the upsert didn't touch, without sending thousands of ids as parameters.
      const isStale = lt(mangaNewsSeries.datasetImportedAt, now);
      const staleIds = tx.select({ id: mangaNewsSeries.id }).from(mangaNewsSeries).where(isStale);
      seriesUnlinked =
        tx.select({ n: count() }).from(series).where(inArray(series.mangaNewsSeriesId, staleIds)).get()?.n ?? 0;
      tx.update(series)
        .set({ volumeCountSource: "manual" })
        .where(and(inArray(series.mangaNewsSeriesId, staleIds), eq(series.volumeCountSource, "manganews")))
        .run();
      tx.delete(mangaNewsSeries).where(isStale).run();
    }

    // Linked series counted by Manga-News follow the new count. A row back at 0 (announced only) leaves it.
    const following = tx
      .select({ id: series.id, volumeCount: series.volumeCount, latest: mangaNewsSeries.volumeCount })
      .from(series)
      .innerJoin(mangaNewsSeries, eq(mangaNewsSeries.id, series.mangaNewsSeriesId))
      .where(and(isNotNull(series.mangaNewsSeriesId), eq(series.volumeCountSource, "manganews")))
      .all()
      .filter((r) => r.latest > 0 && r.latest !== r.volumeCount);
    for (const { id, latest } of following)
      tx.update(series).set({ volumeCount: latest }).where(eq(series.id, id)).run();

    return {
      rowCount: rows.length,
      importedAt: now,
      added: rows.filter((r) => !before.has(r.id)).length,
      removed: stale.length,
      skipped,
      seriesUpdated: following.length,
      seriesUnlinked,
    };
  });
}

/** `excluded.<column>` in an upsert: the value the INSERT tried to write. */
const excluded = (column: string): SQL => sql.raw(`excluded.${column}`);

export type MangaNewsSeriesRow = typeof mangaNewsSeries.$inferSelect;

/**
 * Rows whose title has every word of the query (anywhere, as typed so far), best first: the same
 * title, then titles starting with the query, then the rest, each by most volumes. Spin-offs and
 * editions ("Berserk - Roman") are separate rows, so the main series usually comes first.
 */
export function searchMangaNews(db: Db, query: string, limit = 20): MangaNewsSeriesRow[] {
  const wanted = mangaNewsSearchTitle(query);
  // Normalized words are letters and digits only, so they hold no LIKE wildcards.
  const words = wanted.split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const rows = db
    .select()
    .from(mangaNewsSeries)
    .where(and(...words.map((w) => like(mangaNewsSeries.searchTitle, `%${w}%`))))
    .all();
  const rank = (row: MangaNewsSeriesRow) => {
    const title = row.searchTitle;
    if (title === wanted) return 0;
    if (title.startsWith(`${wanted} `)) return 1;
    if (` ${title} `.includes(` ${wanted} `)) return 2;
    return 3;
  };
  return rows
    .map((row) => ({ row, rank: rank(row) }))
    .sort((a, b) => a.rank - b.rank || b.row.volumeCount - a.row.volumeCount || a.row.title.localeCompare(b.row.title))
    .slice(0, limit)
    .map(({ row }) => row);
}

export function getMangaNewsRow(db: Db, id: number): MangaNewsSeriesRow | undefined {
  return db.select().from(mangaNewsSeries).where(eq(mangaNewsSeries.id, id)).get();
}
