// Database schema, following spec §4.
// TS property names are camelCase; `snakeCase.table` makes the SQL names snake_case.
// Arrays and objects are stored as JSON text. Timestamps are stored as epoch milliseconds.
// Defaults live in SQL (not `$defaultFn`), so raw inserts and migration backfills get them too.
// Index names follow `{table}_{column}_idx`.

import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, check, index, integer, real, snakeCase, text, unique } from "drizzle-orm/sqlite-core";

const table = snakeCase.table;
/** SQLite's rowid. Without AUTOINCREMENT, the id of the last deleted row can be reused. */
const id = () => integer().primaryKey();
const timestamp = () => integer({ mode: "timestamp_ms" });
const createdAt = () => timestamp().notNull().default(sql`(cast(unixepoch('subsec') * 1000 as integer))`);
const jsonList = <T>() => text({ mode: "json" }).$type<T[]>().notNull().default(sql`'[]'`);

/**
 * CHECK that a text column holds one of `values`, so the database enforces what
 * `text({ enum })` only enforces in TypeScript. NULL passes, so nullable columns stay nullable.
 */
const oneOf = (name: string, column: AnySQLiteColumn, values: readonly string[]) =>
  check(name, sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`);

/** IDs copied from MangaBaka (§4.2). */
export interface ExternalIds {
  anilist?: number;
  mal?: number;
  mangaupdates?: string;
}

/** A file the disk scan (§7.5) could not turn into a volume, or a problem with the folder. */
export interface ScanWarning {
  /** File name inside the series folder. Absent for folder-level warnings. */
  file?: string;
  message: string;
}

export const volumeCountSources = ["mangabaka", "manganews", "manual"] as const;
export const searchTermKinds = ["search", "alias"] as const;
export const volumeFormats = ["cbz", "cbr"] as const;
export const volumeSources = ["scan", "import"] as const;
export const titleMatches = ["exact", "partial", "none"] as const;
export const downloadStatuses = [
  "downloading",
  "importing",
  "imported",
  "needs_attention",
  "missing_from_client",
] as const;
export const importActions = ["imported", "skipped_owned", "skipped_unparseable", "skipped_format", "error"] as const;

// §4.1
export const languages = table("languages", {
  id: id(),
  code: text().notNull().unique(),
  name: text().notNull(),
  prowlarrIndexerIds: jsonList<number>(),
  /** Empty means all categories. */
  prowlarrCategories: jsonList<number>(),
  rootFolder: text().notNull(),
  /** When null, no Komga scan is triggered. */
  komgaLibraryId: text(),
  /** Why the last Komga scan of that library failed. Cleared by a scan that works, or a new library. */
  komgaScanError: text(),
  komgaScanErrorAt: timestamp(),
  useMangaNewsDataset: integer({ mode: "boolean" }).notNull().default(false),
});

// §4.7: rows from the Manga-News CSV. The id is Manga-News' own `site_id`, so a refresh keeps
// series links (§6.5).
export const mangaNewsSeries = table("manga_news_series", {
  id: integer().primaryKey(),
  url: text().notNull(),
  title: text().notNull(),
  /** `title` with a trailing "(les)" moved to the front, then normalized: what search compares. */
  searchTitle: text().notNull(),
  publisher: text(),
  /** Volumes published in French so far. 0 for a series that is only announced. */
  volumeCount: integer().notNull(),
  artists: text(),
  writers: text(),
  genres: jsonList<string>(),
  coverUrl: text(),
  /** When the refresh that last wrote this row ran. */
  datasetImportedAt: timestamp().notNull(),
});

// §4.2
export const series = table(
  "series",
  {
    id: id(),
    languageId: integer()
      .notNull()
      .references(() => languages.id),
    mangabakaId: integer().notNull(),
    externalIds: text({ mode: "json" }).$type<ExternalIds>().notNull().default(sql`'{}'`),
    displayTitle: text().notNull(),
    folderPath: text().notNull().unique(),
    coverUrl: text(),
    status: text(),
    publisher: text(),
    authors: jsonList<string>(),
    volumeCount: integer(),
    volumeCountSource: text({ enum: volumeCountSources }),
    /** Set by hand in the add-series flow (§7.1). Cleared if a refresh drops the row. */
    mangaNewsSeriesId: integer().references(() => mangaNewsSeries.id, { onDelete: "set null" }),
    metadataJson: text({ mode: "json" }).$type<unknown>(),
    metadataFetchedAt: timestamp(),
    lastScannedAt: timestamp(),
    /** From the last disk scan (§7.5): files it couldn't use, duplicate numbers. Shown on the series page. */
    scanWarnings: jsonList<ScanWarning>(),
  },
  (t) => [
    // Also serves lookups by language, as language_id is its first column.
    unique().on(t.languageId, t.mangabakaId),
    index("series_manga_news_series_id_idx").on(t.mangaNewsSeriesId),
    oneOf("series_volume_count_source_check", t.volumeCountSource, volumeCountSources),
  ],
);

// §4.3
export const searchTerms = table(
  "search_terms",
  {
    id: id(),
    seriesId: integer()
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    term: text().notNull(),
    kind: text({ enum: searchTermKinds }).notNull(),
  },
  (t) => [unique().on(t.seriesId, t.term), oneOf("search_terms_kind_check", t.kind, searchTermKinds)],
);

// §4.4: a row exists only when mangarr owns the file on disk.
export const volumes = table(
  "volumes",
  {
    id: id(),
    seriesId: integer()
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    /** Decimal volumes like 10.5 are stored exactly as a REAL. */
    number: real().notNull(),
    filePath: text().notNull().unique(),
    fileSize: integer().notNull(),
    format: text({ enum: volumeFormats }).notNull(),
    source: text({ enum: volumeSources }).notNull(),
  },
  (t) => [
    unique().on(t.seriesId, t.number),
    oneOf("volumes_format_check", t.format, volumeFormats),
    oneOf("volumes_source_check", t.source, volumeSources),
  ],
);

// §4.5
export const downloads = table(
  "downloads",
  {
    id: id(),
    seriesId: integer()
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    /** v1 SHA-1 info-hash, lowercase hex. */
    infoHash: text().notNull().unique(),
    releaseTitle: text().notNull(),
    indexerName: text().notNull(),
    prowlarrGuid: text().notNull(),
    size: integer().notNull(),
    /** Empty for complete packs with no numbers; the import step works them out from the files. */
    expectedVolumes: jsonList<number>(),
    titleMatch: text({ enum: titleMatches }).notNull(),
    status: text({ enum: downloadStatuses }).notNull().default("downloading"),
    statusMessage: text(),
    grabbedAt: createdAt(),
    completedAt: timestamp(),
    importedAt: timestamp(),
  },
  (t) => [
    index("downloads_series_id_idx").on(t.seriesId),
    oneOf("downloads_title_match_check", t.titleMatch, titleMatches),
    oneOf("downloads_status_check", t.status, downloadStatuses),
  ],
);

// §4.6
export const importLogEntries = table(
  "import_log_entries",
  {
    id: id(),
    downloadId: integer()
      .notNull()
      .references(() => downloads.id, { onDelete: "cascade" }),
    sourceFile: text().notNull(),
    action: text({ enum: importActions }).notNull(),
    volumeNumber: real(),
    destPath: text(),
    message: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("import_log_entries_download_id_idx").on(t.downloadId),
    oneOf("import_log_entries_action_check", t.action, importActions),
  ],
);

// §4.8. See settings.ts for the typed keys.
export const settings = table("settings", {
  key: text().primaryKey(),
  value: text({ mode: "json" }).$type<unknown>().notNull(),
});

// §4.9. One row in v0.
export const users = table("users", {
  id: id(),
  username: text().notNull().unique(),
  /** Argon2id, from `Bun.password.hash`. */
  passwordHash: text().notNull(),
  createdAt: createdAt(),
});

// §4.10
export const sessions = table(
  "sessions",
  {
    /** SHA-256 of the cookie's token, hex. The token itself is never stored. */
    id: text().primaryKey(),
    userId: integer()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp().notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);
