// Manga-News procedures (spec §6.5, §7.1, §9): the dataset's status and "Refresh dataset" for the
// Settings screen, and title search for the add-series flow.

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { downloadMangaNewsCsv, parseMangaNewsCsv } from "../integrations/manganews";
import { UpstreamError } from "../integrations/upstream";
import {
  datasetStatus,
  type MangaNewsSeriesRow,
  mangaNewsDisplayTitle,
  searchMangaNews,
  storeMangaNewsDataset,
} from "../library/manganews";
import { getSetting } from "../settings";
import { authed } from "./base";

const statusOutput = z.object({
  /** 0 until the first refresh. */
  rowCount: z.int(),
  importedAt: z.date().nullable(),
});

export const mangaNewsRowOutput = z.object({
  /** Manga-News' own id. */
  id: z.int(),
  url: z.string(),
  /** As Manga-News files it: "Envol (l')". */
  title: z.string(),
  /** With the article in front: "L'envol". */
  displayTitle: z.string(),
  publisher: z.string().nullable(),
  /** Volumes published in French. 0 for an announced series. */
  volumeCount: z.int(),
  artists: z.string().nullable(),
  writers: z.string().nullable(),
  genres: z.array(z.string()),
  coverUrl: z.string().nullable(),
});

export const toMangaNewsOutput = (row: MangaNewsSeriesRow): z.infer<typeof mangaNewsRowOutput> => ({
  ...row,
  displayTitle: mangaNewsDisplayTitle(row.title),
});

const tags = ["Manga-News"];

export const mangaNewsRouter = {
  status: authed
    .route({ method: "GET", path: "/manga-news", summary: "Get the Manga-News dataset's status", tags })
    .output(statusOutput)
    .handler(({ context }) => datasetStatus(context.db)),

  refresh: authed
    .route({
      method: "POST",
      path: "/manga-news/refresh",
      summary: "Refresh the Manga-News dataset",
      description:
        "Downloads the CSV from the saved URL and replaces the table. Links from series are kept; linked series whose volume count came from Manga-News get the new count. If the download or the file is bad, the current dataset is kept.",
      tags,
    })
    .output(
      statusOutput.extend({
        added: z.int(),
        removed: z.int(),
        skipped: z.int(),
        seriesUpdated: z.int(),
        seriesUnlinked: z.int(),
      }),
    )
    .handler(async ({ context: { db }, signal }) => {
      const url = getSetting(db, "mangaNewsCsvUrl");
      if (!url) throw new UpstreamError("not_configured", "Set the Manga-News CSV URL in Settings first");
      const parsed = parseMangaNewsCsv(await downloadMangaNewsCsv(url, { signal }));
      if (parsed.rows.length === 0) {
        throw new UpstreamError(
          "invalid_response",
          "The Manga-News CSV has no usable rows; the current dataset is kept",
        );
      }
      const result = storeMangaNewsDataset(db, parsed);
      console.log(
        `manga-news: dataset refreshed, ${result.rowCount} series (${result.added} new, ${result.removed} removed)`,
      );
      return result;
    }),

  search: authed
    .route({
      method: "GET",
      path: "/manga-news/search",
      summary: "Search the Manga-News dataset by title",
      description:
        "Every word must appear in the title. The same title first, then titles starting with the query, then the most volumes.",
      tags,
    })
    .input(z.object({ query: z.string().trim().min(1), limit: z.int().min(1).max(100).default(20) }))
    .output(z.array(mangaNewsRowOutput))
    .handler(({ context: { db }, input }) => {
      if (datasetStatus(db).rowCount === 0) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "The Manga-News dataset is empty: refresh it in Settings first",
        });
      }
      return searchMangaNews(db, input.query, input.limit).map(toMangaNewsOutput);
    }),
};
