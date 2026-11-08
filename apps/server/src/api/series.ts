// Series procedures (spec §4.2–§4.4, §7.1, §7.5, §9): the add-series flow, the series list and
// detail, editing, search terms, rescan and metadata refresh.

import { ORPCError } from "@orpc/server";
import { and, count, eq, getColumns } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import {
  languages,
  type ScanWarning,
  searchTermKinds,
  searchTerms,
  series,
  volumeCountSources,
  volumeFormats,
  volumes,
  volumeSources,
} from "../db/schema";
import type { MangaBakaClient } from "../integrations/mangabaka";
import { isDirectory, proposeFolder, usedFolders } from "../library/folders";
import { getMangaNewsRow, type MangaNewsSeriesRow } from "../library/manganews";
import { isInside, joinPath, normalizePath, sanitizeName } from "../library/paths";
import { draftAuthors, draftPublisher, draftTerms, draftVolumeCount, type VolumeCountDraft } from "../library/prefill";
import { scanSeries } from "../library/scan";
import { authed } from "./base";
import { getLanguage } from "./languages";
import { mangaNewsRowOutput, toMangaNewsOutput } from "./manganews";

const id = z.int().positive();
const nonEmpty = z.string().trim().min(1);
/** Trimmed, without blanks or repeats. */
const nameList = z.array(z.string()).transform((list) => [...new Set(list.map((s) => s.trim()).filter(Boolean))]);
const volumeCount = z.int().positive().nullable();

// ---- Outputs (each schema drops the fields it doesn't list) ----

const seriesFields = z.object({
  id,
  languageId: id,
  mangabakaId: z.int(),
  externalIds: z.object({ anilist: z.int().optional(), mal: z.int().optional(), mangaupdates: z.string().optional() }),
  displayTitle: z.string(),
  folderPath: z.string(),
  coverUrl: z.string().nullable(),
  status: z.string().nullable(),
  publisher: z.string().nullable(),
  authors: z.array(z.string()),
  volumeCount: z.int().nullable(),
  volumeCountSource: z.enum(volumeCountSources).nullable(),
  mangaNewsSeriesId: z.int().nullable(),
  metadataFetchedAt: z.date().nullable(),
  lastScannedAt: z.date().nullable(),
});

const listItem = seriesFields.extend({ languageCode: z.string(), ownedCount: z.int() });

const termOutput = z.object({ id, term: z.string(), kind: z.enum(searchTermKinds) });

const volumeOutput = z.object({
  id,
  number: z.number(),
  filePath: z.string(),
  fileSize: z.int(),
  format: z.enum(volumeFormats),
  source: z.enum(volumeSources),
});

const detailOutput = seriesFields.extend({
  language: z.object({ id, code: z.string(), name: z.string() }),
  /** The linked Manga-News row. */
  mangaNews: mangaNewsRowOutput.nullable(),
  searchTerms: z.array(termOutput),
  /** Owned volumes, by number. */
  volumes: z.array(volumeOutput),
  /** Numbers from 1 to `volumeCount` with no volume. */
  missing: z.array(z.int()),
  /** Missing numbers an active download is expected to bring. */
  downloading: z.array(z.int()),
  /** From the last disk scan. */
  scanWarnings: z.array(z.object({ file: z.string().optional(), message: z.string() }) satisfies z.ZodType<ScanWarning>),
});

type Detail = z.infer<typeof detailOutput>;

const { metadataJson: _metadata, scanWarnings: _warnings, ...summaryColumns } = getColumns(series);

const notFound = (seriesId: number) => new ORPCError("NOT_FOUND", { message: `Series ${seriesId} not found` });

function requireSeries(db: Db, seriesId: number) {
  if (!db.select({ id: series.id }).from(series).where(eq(series.id, seriesId)).get()) throw notFound(seriesId);
}

function loadDetail(db: Db, seriesId: number): Detail {
  const row = db.query.series
    .findFirst({
      where: { id: seriesId },
      columns: { metadataJson: false },
      with: {
        language: true,
        mangaNews: true,
        searchTerms: { orderBy: { id: "asc" } },
        volumes: { orderBy: { number: "asc" } },
        downloads: { columns: { expectedVolumes: true }, where: { status: { in: ["downloading", "importing"] } } },
      },
    })
    .sync();
  if (!row) throw notFound(seriesId);

  const owned = new Set(row.volumes.map((v) => v.number));
  const missing: number[] = [];
  for (let n = 1; n <= (row.volumeCount ?? 0); n++) if (!owned.has(n)) missing.push(n);
  const expected = new Set(row.downloads.flatMap((d) => d.expectedVolumes));

  return {
    ...row,
    mangaNews: row.mangaNews ? toMangaNewsOutput(row.mangaNews) : null,
    // Search terms first, then aliases, each in the order they were added.
    searchTerms: [...row.searchTerms.filter((t) => t.kind === "search"), ...row.searchTerms.filter((t) => t.kind === "alias")],
    missing,
    downloading: missing.filter((n) => expected.has(n)),
  };
}

// ---- Shared steps ----

/** The series using `folderPath`. */
function folderOwner(db: Db, folderPath: string) {
  return db
    .select({ id: series.id, displayTitle: series.displayTitle })
    .from(series)
    .where(eq(series.folderPath, folderPath))
    .get();
}

function alreadyAdded(db: Db, languageId: number, mangabakaId: number) {
  return db
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.languageId, languageId), eq(series.mangabakaId, mangabakaId)))
    .get();
}

/**
 * The MangaBaka record with everything the add-series flow pre-fills. Collections (one more
 * request) are only fetched when the volume count is wanted.
 */
async function fetchDraft(
  client: MangaBakaClient,
  mangabakaId: number,
  languageCode: string,
  { withVolumeCount = true, signal }: { withVolumeCount?: boolean; signal?: AbortSignal } = {},
) {
  const { series: record, record: raw } = await client.getSeries(mangabakaId, signal);
  const collections = withVolumeCount ? await client.collections(record.id, signal) : [];
  return {
    record,
    terms: draftTerms(record, languageCode),
    authors: draftAuthors(record),
    volumes: draftVolumeCount(record, collections, languageCode),
    /** The columns saved from MangaBaka, on create and on refresh. */
    metadata: {
      mangabakaId: record.id,
      externalIds: record.externalIds,
      coverUrl: record.coverUrl ?? null,
      status: record.status,
      publisher: draftPublisher(record, languageCode) ?? null,
      metadataJson: raw,
      metadataFetchedAt: new Date(),
    } satisfies Partial<typeof series.$inferInsert>,
  };
}

/** A count chosen in the add-series flow is MangaBaka's when it matches one MangaBaka offered. */
function chosenVolumeCount(
  input: number | null | undefined,
  draft: VolumeCountDraft,
  finalVolume: number | undefined,
): Pick<typeof series.$inferInsert, "volumeCount" | "volumeCountSource"> {
  if (input === undefined) {
    return { volumeCount: draft.volumeCount, volumeCountSource: draft.volumeCount === null ? null : "mangabaka" };
  }
  if (input === null) return { volumeCount: null, volumeCountSource: null };
  // The draft's own count is one of these: an option's count or the floored final volume.
  const offered =
    draft.options.some((o) => o.volumeCount === input) || (finalVolume !== undefined && input === Math.floor(finalVolume));
  return { volumeCount: input, volumeCountSource: offered ? "mangabaka" : "manual" };
}

function requireMangaNewsRow(db: Db, mangaNewsSeriesId: number): MangaNewsSeriesRow {
  const row = getMangaNewsRow(db, mangaNewsSeriesId);
  if (!row) {
    throw new ORPCError("BAD_REQUEST", { message: `No Manga-News series ${mangaNewsSeriesId} in the dataset; refresh it or search again` });
  }
  return row;
}

/**
 * The count a Manga-News link sets (§7.1): the row's, when no count was given or the one given is
 * the row's. Undefined when the given count wins, or the row only announces the series (0 volumes).
 */
function linkedVolumeCount(
  row: MangaNewsSeriesRow,
  given: number | null | undefined,
): Pick<typeof series.$inferInsert, "volumeCount" | "volumeCountSource"> | undefined {
  if (row.volumeCount === 0) return undefined;
  if (given === undefined || given === row.volumeCount) return { volumeCount: row.volumeCount, volumeCountSource: "manganews" };
  return undefined;
}

/** Search terms and aliases as rows: search terms first, an alias that is also a search term dropped. */
function termRows(seriesId: number, terms: { term: string; kind: (typeof searchTermKinds)[number] }[]) {
  const seen = new Set<string>();
  const ordered = [...terms.filter((t) => t.kind === "search"), ...terms.filter((t) => t.kind === "alias")];
  return ordered.flatMap((t) => {
    if (seen.has(t.term)) return [];
    seen.add(t.term);
    return [{ seriesId, term: t.term, kind: t.kind }];
  });
}

/** The folder for a new series: the one given (existing, inside the root), or `<root>/<displayTitle>`. */
async function resolveFolder(rootFolder: string, displayTitle: string, given: string | undefined): Promise<string> {
  if (given === undefined) {
    const name = sanitizeName(displayTitle);
    if (!name) throw new ORPCError("BAD_REQUEST", { message: "The display title has no usable characters for a folder name" });
    return joinPath(rootFolder, name);
  }
  if (!isInside(rootFolder, given)) throw new ORPCError("BAD_REQUEST", { message: `The folder must be inside ${rootFolder}` });
  if (!(await isDirectory(given))) throw new ORPCError("BAD_REQUEST", { message: `${given} is not an existing folder` });
  return given;
}

// ---- Inputs ----

const createInput = z.object({
  languageId: id,
  mangabakaId: id,
  displayTitle: nonEmpty,
  /** Sent to Prowlarr. At least one. */
  searchTerms: nameList.refine((list) => list.length > 0, "Give at least one search term"),
  /** Accepted when matching, never queried. */
  aliases: nameList.default([]),
  /** Defaults to MangaBaka's authors and artists. */
  authors: nameList.optional(),
  /** Defaults to MangaBaka's count; null means unknown. */
  volumeCount: volumeCount.optional(),
  /** An existing folder inside the language root. Defaults to `<rootFolder>/<displayTitle>`. */
  folderPath: z.string().trim().min(1).transform(normalizePath).optional(),
  /** A Manga-News row picked by hand. Sets the publisher, and the volume count unless one is given. */
  mangaNewsSeriesId: id.optional(),
});

const termInput = z.object({ term: nonEmpty, kind: z.enum(searchTermKinds) });

const tags = ["Series"];

export const seriesRouter = {
  list: authed
    .route({ method: "GET", path: "/series", summary: "List series", tags })
    // A language code rather than an id: the UI's `?language=fr` and REST callers pass the same thing.
    .input(z.object({ language: z.string().optional() }))
    .output(z.array(listItem))
    .handler(({ context: { db }, input }) => {
      const rows = db
        .select({ ...summaryColumns, languageCode: languages.code, ownedCount: count(volumes.id) })
        .from(series)
        .innerJoin(languages, eq(languages.id, series.languageId))
        .leftJoin(volumes, eq(volumes.seriesId, series.id))
        .where(input.language === undefined ? undefined : eq(languages.code, input.language))
        .groupBy(series.id)
        .all();
      return rows.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
    }),

  get: authed
    .route({ method: "GET", path: "/series/{id}", summary: "Get a series", tags })
    .input(z.object({ id }))
    .output(detailOutput)
    .handler(({ context, input }) => loadDetail(context.db, input.id)),

  draft: authed
    .route({
      method: "GET",
      path: "/series/draft",
      summary: "Pre-fill a new series",
      description:
        "Everything the add-series form starts with, from MangaBaka: search terms, aliases, authors, display title, volume count and folder. Saves nothing.",
      tags,
    })
    .input(z.object({ mangabakaId: id, languageId: id }))
    .output(
      z.object({
        /** Differs from the requested ID when MangaBaka merged that series into another. */
        mangabakaId: z.int(),
        title: z.string(),
        nativeTitle: z.string().optional(),
        type: z.string(),
        status: z.string(),
        year: z.int().optional(),
        coverUrl: z.string().optional(),
        /** The series in this language, when it is already added. */
        existingSeriesId: id.nullable(),
        displayTitle: z.string(),
        searchTerms: z.array(z.string()),
        aliases: z.array(z.string()),
        authors: z.array(z.string()),
        publisher: z.string().nullable(),
        volumeCount: z.int().nullable(),
        volumeCountFrom: z.enum(["collection", "final_volume"]).nullable(),
        /** Other editions MangaBaka knows in this language, largest first. */
        volumeCountOptions: z.array(
          z.object({
            edition: z.string().optional(),
            medium: z.string().optional(),
            publisher: z.string().optional(),
            volumeCount: z.int(),
          }),
        ),
        finalVolume: z.number().optional(),
        /**
         * `<rootFolder>/<displayTitle>`, or else an existing, unused folder in the root named after one
         * of the series' titles.
         */
        folderPath: z.string(),
        folderFrom: z.enum(["display_title", "matching_name"]),
        /** When true, the folder is adopted and scanned. */
        folderExists: z.boolean(),
        /** Another series already using that folder. */
        folderSeriesId: id.nullable(),
      }),
    )
    .handler(async ({ context: { db, mangabaka }, input, signal }) => {
      const language = getLanguage(db, input.languageId);
      const { record, terms, authors, volumes: count, metadata } = await fetchDraft(mangabaka, input.mangabakaId, language.code, {
        signal,
      });

      const displayTitle = terms.searchTerms[0] ?? record.title;
      const folderName = sanitizeName(displayTitle) || sanitizeName(record.title) || `MangaBaka ${record.id}`;
      const folder = await proposeFolder(language.rootFolder, folderName, [...terms.searchTerms, ...terms.aliases], usedFolders(db, language.id));

      return {
        ...record,
        mangabakaId: record.id,
        existingSeriesId: alreadyAdded(db, language.id, record.id)?.id ?? null,
        displayTitle,
        searchTerms: terms.searchTerms,
        aliases: terms.aliases,
        authors,
        publisher: metadata.publisher,
        volumeCount: count.volumeCount,
        volumeCountFrom: count.from,
        volumeCountOptions: count.options,
        folderPath: folder.path,
        folderFrom: folder.from,
        folderExists: folder.exists,
        folderSeriesId: folderOwner(db, folder.path)?.id ?? null,
      };
    }),

  create: authed
    .route({
      method: "POST",
      path: "/series",
      summary: "Add a series",
      description:
        "Fetches the MangaBaka record again, saves the series with its search terms, then scans its folder. The folder is not created: the first import does that.",
      tags,
      successStatus: 201,
    })
    .input(createInput)
    .output(detailOutput)
    .handler(async ({ context: { db, mangabaka }, input, signal }) => {
      const language = getLanguage(db, input.languageId);
      const mangaNews = input.mangaNewsSeriesId === undefined ? undefined : requireMangaNewsRow(db, input.mangaNewsSeriesId);
      const folderPath = await resolveFolder(language.rootFolder, input.displayTitle, input.folderPath);
      const owner = folderOwner(db, folderPath);
      if (owner) throw new ORPCError("CONFLICT", { message: `"${owner.displayTitle}" already uses ${folderPath}` });

      const fromMangaNews = mangaNews && linkedVolumeCount(mangaNews, input.volumeCount);
      const draft = await fetchDraft(mangabaka, input.mangabakaId, language.code, {
        withVolumeCount: input.volumeCount !== null && !fromMangaNews,
        signal,
      });
      const { record } = draft;
      if (alreadyAdded(db, language.id, record.id)) {
        throw new ORPCError("CONFLICT", { message: `${record.title} is already added in ${language.name}` });
      }

      const created = db.transaction((tx) => {
        const row = tx
          .insert(series)
          .values({
            ...draft.metadata,
            languageId: language.id,
            displayTitle: input.displayTitle,
            folderPath,
            authors: input.authors ?? draft.authors,
            ...(fromMangaNews ?? chosenVolumeCount(input.volumeCount, draft.volumes, record.finalVolume)),
            ...(mangaNews && {
              mangaNewsSeriesId: mangaNews.id,
              // MangaBaka rarely knows French publishers.
              publisher: mangaNews.publisher ?? draft.metadata.publisher,
            }),
          })
          .returning({ id: series.id })
          .get();
        const terms = termRows(row.id, [
          ...input.searchTerms.map((term) => ({ term, kind: "search" as const })),
          ...input.aliases.map((term) => ({ term, kind: "alias" as const })),
        ]);
        tx.insert(searchTerms).values(terms).run();
        return row;
      });

      await scanSeries(db, created.id);
      return loadDetail(db, created.id);
    }),

  update: authed
    .route({
      method: "PATCH",
      path: "/series/{id}",
      summary: "Update a series",
      description:
        "Omitted fields keep their value. Setting the volume count marks it as entered by hand. The folder doesn't move when the display title changes. Linking a Manga-News row sets the publisher and, unless a count is given, the volume count; unlinking (null) keeps both.",
      tags,
    })
    .input(
      z.object({
        id,
        displayTitle: nonEmpty.optional(),
        authors: nameList.optional(),
        volumeCount: volumeCount.optional(),
        mangaNewsSeriesId: id.nullable().optional(),
      }),
    )
    .output(detailOutput)
    .handler(({ context: { db }, input: { id: seriesId, volumeCount: newCount, mangaNewsSeriesId, ...changes } }) => {
      const set: Partial<typeof series.$inferInsert> = {};
      if (changes.displayTitle !== undefined) set.displayTitle = changes.displayTitle;
      if (changes.authors !== undefined) set.authors = changes.authors;
      if (newCount !== undefined) {
        set.volumeCount = newCount;
        set.volumeCountSource = newCount === null ? null : "manual";
      }
      if (mangaNewsSeriesId === null) {
        set.mangaNewsSeriesId = null;
        const current = db.select({ source: series.volumeCountSource }).from(series).where(eq(series.id, seriesId)).get();
        if (!current) throw notFound(seriesId);
        // The count stays, but no refresh updates it any more.
        if (newCount === undefined && current.source === "manganews") set.volumeCountSource = "manual";
      } else if (mangaNewsSeriesId !== undefined) {
        const row = requireMangaNewsRow(db, mangaNewsSeriesId);
        set.mangaNewsSeriesId = row.id;
        if (row.publisher) set.publisher = row.publisher;
        Object.assign(set, linkedVolumeCount(row, newCount));
      }
      if (Object.keys(set).length > 0) {
        const updated = db.update(series).set(set).where(eq(series.id, seriesId)).returning({ id: series.id }).get();
        if (!updated) throw notFound(seriesId);
      }
      return loadDetail(db, seriesId);
    }),

  delete: authed
    .route({
      method: "DELETE",
      path: "/series/{id}",
      summary: "Delete a series",
      description: "Removes it from mangarr with its search terms, volumes and downloads. Files on disk and torrents are left alone.",
      tags,
      successStatus: 204,
    })
    .input(z.object({ id }))
    .handler(({ context: { db }, input }) => {
      const deleted = db.delete(series).where(eq(series.id, input.id)).returning({ id: series.id }).get();
      if (!deleted) throw notFound(input.id);
    }),

  replaceSearchTerms: authed
    .route({
      method: "PUT",
      path: "/series/{id}/search-terms",
      summary: "Replace a series' search terms and aliases",
      description: "Needs at least one `search` term. Repeats are dropped; a term given as both kinds stays a search term.",
      tags,
    })
    .input(z.object({ id, terms: z.array(termInput) }))
    .output(z.array(termOutput))
    .handler(({ context: { db }, input }) => {
      if (!input.terms.some((t) => t.kind === "search")) {
        throw new ORPCError("BAD_REQUEST", { message: "Give at least one search term" });
      }
      requireSeries(db, input.id);
      // termRows puts search terms first, so the new ids come out in display order.
      return db.transaction((tx) => {
        tx.delete(searchTerms).where(eq(searchTerms.seriesId, input.id)).run();
        return tx.insert(searchTerms).values(termRows(input.id, input.terms)).returning().all();
      });
    }),

  addSearchTerm: authed
    .route({
      method: "POST",
      path: "/series/{id}/search-terms",
      summary: "Add a search term or alias",
      description: "For the interactive search's \"Add alias\" action.",
      tags,
      successStatus: 201,
    })
    .input(termInput.extend({ id }))
    .output(termOutput)
    .handler(({ context: { db }, input }) => {
      requireSeries(db, input.id);
      const clash = db
        .select({ kind: searchTerms.kind })
        .from(searchTerms)
        .where(and(eq(searchTerms.seriesId, input.id), eq(searchTerms.term, input.term)))
        .get();
      if (clash) {
        throw new ORPCError("CONFLICT", {
          message: `"${input.term}" is already ${clash.kind === "search" ? "a search term" : "an alias"}`,
        });
      }
      return db.insert(searchTerms).values({ seriesId: input.id, term: input.term, kind: input.kind }).returning().get();
    }),

  rescan: authed
    .route({ method: "POST", path: "/series/{id}/rescan", summary: "Rescan a series folder", tags })
    .input(z.object({ id }))
    .output(detailOutput)
    .handler(async ({ context: { db }, input }) => {
      requireSeries(db, input.id);
      await scanSeries(db, input.id);
      return loadDetail(db, input.id);
    }),

  refreshMetadata: authed
    .route({
      method: "POST",
      path: "/series/{id}/refresh-metadata",
      summary: "Refresh a series from MangaBaka",
      description:
        "Updates the cover, status, publisher, external IDs and cached record. The volume count changes only when it came from MangaBaka, and the publisher only when no Manga-News row is linked. Search terms, authors and the display title are left alone.",
      tags,
    })
    .input(z.object({ id }))
    .output(detailOutput)
    .handler(async ({ context: { db, mangabaka }, input, signal }) => {
      const row = db.query.series
        .findFirst({ where: { id: input.id }, columns: { metadataJson: false }, with: { language: true } })
        .sync();
      if (!row) throw notFound(input.id);

      const fromMangaBaka = row.volumeCountSource === "mangabaka";
      const { record, metadata, volumes: count } = await fetchDraft(mangabaka, row.mangabakaId, row.language.code, {
        withVolumeCount: fromMangaBaka,
        signal,
      });
      if (record.id !== row.mangabakaId) {
        const other = alreadyAdded(db, row.languageId, record.id);
        if (other) {
          throw new ORPCError("CONFLICT", {
            message: `MangaBaka merged this series into ${record.id}, which is already added as series ${other.id}`,
          });
        }
      }

      const set: Partial<typeof series.$inferInsert> = {
        ...metadata,
        // MangaBaka losing a cover or a publisher doesn't erase the ones we have.
        coverUrl: metadata.coverUrl ?? row.coverUrl,
        // A linked Manga-News row knows the French publisher better than MangaBaka.
        publisher: row.mangaNewsSeriesId === null ? (metadata.publisher ?? row.publisher) : row.publisher,
      };
      if (fromMangaBaka) {
        set.volumeCount = count.volumeCount;
        if (count.volumeCount === null) set.volumeCountSource = null;
      }
      db.update(series).set(set).where(eq(series.id, input.id)).run();
      return loadDetail(db, input.id);
    }),
};
