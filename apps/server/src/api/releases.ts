// Release procedures: interactive search (spec §7.2) and grab (§7.3).

import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { downloads, downloadStatuses, series, titleMatches } from "../db/schema";
import { prowlarrFromSettings } from "../integrations/prowlarr";
import { qbittorrentFromSettings } from "../integrations/qbittorrent";
import { infoHashOf, TorrentError } from "../integrations/torrent";
import { releaseCacheTtlMs } from "../library/release-cache";
import { searchReleases } from "../library/search";
import { authed } from "./base";

const id = z.int().positive();

// Prowlarr's downloadUrl and magnetUrl hold its API key, so they never leave the server.
const resultOutput = z.object({
  /** What Grab takes. */
  guid: z.string(),
  /** The release name, as the indexer gave it. */
  title: z.string(),
  indexerId: z.int(),
  indexer: z.string(),
  /** Bytes; 0 when the indexer didn't say. */
  size: z.number(),
  seeders: z.int().optional(),
  leechers: z.int().optional(),
  publishDate: z.date().optional(),
  /** The release's page on the indexer. */
  infoUrl: z.string().optional(),
  infoHash: z.string().optional(),
  /** From `titleMatch()` against the series' search terms, aliases and authors. */
  match: z.enum(titleMatches),
  /** What "Add alias" saves. */
  parsedTitle: z.string(),
  volumes: z.array(z.number()),
  /** Volumes in the release that the series doesn't own. */
  newVolumes: z.array(z.number()),
  coversMissing: z.boolean(),
  isComplete: z.boolean(),
  hasExtraChapters: z.boolean(),
  group: z.string().optional(),
  editionHint: z.string().optional(),
  source: z.enum(["digital", "compilation", "scan"]).optional(),
  contentHint: z.enum(["audiobook", "novel", "artbook"]).optional(),
  /** The series already has a download for this release. */
  grabbed: z.boolean(),
});

export const downloadOutput = z.object({
  id,
  seriesId: id,
  infoHash: z.string(),
  releaseTitle: z.string(),
  indexerName: z.string(),
  prowlarrGuid: z.string(),
  size: z.number(),
  expectedVolumes: z.array(z.number()),
  titleMatch: z.enum(titleMatches),
  status: z.enum(downloadStatuses),
  statusMessage: z.string().nullable(),
  grabbedAt: z.date(),
  completedAt: z.date().nullable(),
  importedAt: z.date().nullable(),
});

function requireSeries(db: Db, seriesId: number) {
  if (!db.select({ id: series.id }).from(series).where(eq(series.id, seriesId)).get()) {
    throw new ORPCError("NOT_FOUND", { message: `Series ${seriesId} not found` });
  }
}

/** Info-hashes are unique across series: the same torrent is never tracked twice. */
function assertNotGrabbed(db: Db, infoHash: string) {
  const existing = db
    .select({ title: series.displayTitle })
    .from(downloads)
    .innerJoin(series, eq(series.id, downloads.seriesId))
    .where(eq(downloads.infoHash, infoHash))
    .get();
  if (existing) throw new ORPCError("CONFLICT", { message: `This torrent was already grabbed for ${existing.title}` });
}

const tags = ["Releases"];

export const releasesRouter = {
  search: authed
    .route({
      method: "GET",
      path: "/series/{id}/releases",
      summary: "Search for releases",
      description:
        "Queries Prowlarr once per search term (never aliases) on the indexers of the series language. Results are deduplicated, chapter releases dropped, and sorted by title match, then whether they bring a volume you don't own, then seeders. Grab works on the latest results for 30 minutes.",
      tags,
    })
    .input(z.object({ id }))
    .output(
      z.object({
        /** The search terms sent to Prowlarr. */
        queries: z.array(z.string()),
        results: z.array(resultOutput),
        /** Results across every query, before duplicates were removed. */
        received: z.int(),
        chapterReleases: z.int(),
        usenetReleases: z.int(),
      }),
    )
    .handler(async ({ context: { db, releases }, input, signal }) => {
      const row = db.query.series
        .findFirst({
          where: { id: input.id },
          columns: { id: true, authors: true, volumeCount: true },
          with: {
            language: true,
            searchTerms: { orderBy: { id: "asc" } },
            volumes: { columns: { number: true } },
            downloads: { columns: { infoHash: true, prowlarrGuid: true } },
          },
        })
        .sync();
      if (!row) throw new ORPCError("NOT_FOUND", { message: `Series ${input.id} not found` });

      const { language } = row;
      if (language.prowlarrIndexerIds.length === 0) {
        throw new ORPCError("PRECONDITION_FAILED", { message: `Choose Prowlarr indexers for ${language.name} in Settings first` });
      }
      const queries = row.searchTerms.filter((t) => t.kind === "search").map((t) => t.term);
      if (queries.length === 0) throw new ORPCError("PRECONDITION_FAILED", { message: "The series has no search terms" });

      const outcome = await searchReleases(
        prowlarrFromSettings(db),
        {
          queries,
          names: row.searchTerms.map((t) => t.term),
          authors: row.authors,
          owned: row.volumes.map((v) => v.number),
          volumeCount: row.volumeCount,
        },
        language,
        signal,
      );
      releases.set(row.id, outcome.results);

      const grabbedHashes = new Set(row.downloads.map((d) => d.infoHash));
      const grabbedGuids = new Set(row.downloads.map((d) => d.prowlarrGuid));

      return {
        queries,
        received: outcome.received,
        chapterReleases: outcome.chapterReleases,
        usenetReleases: outcome.usenetReleases,
        results: outcome.results.map(({ release, parsed, match, newVolumes, coversMissing }) => ({
          guid: release.guid,
          title: release.title,
          indexerId: release.indexerId,
          indexer: release.indexer,
          size: release.size,
          seeders: release.seeders,
          leechers: release.leechers,
          publishDate: release.publishDate === undefined ? undefined : new Date(release.publishDate),
          infoUrl: release.infoUrl,
          infoHash: release.infoHash,
          match,
          parsedTitle: parsed.title,
          volumes: parsed.volumes,
          newVolumes,
          coversMissing,
          isComplete: parsed.isComplete,
          hasExtraChapters: parsed.hasExtraChapters,
          group: parsed.group,
          editionHint: parsed.editionHint,
          source: parsed.source,
          contentHint: parsed.contentHint,
          grabbed: (release.infoHash !== undefined && grabbedHashes.has(release.infoHash)) || grabbedGuids.has(release.guid),
        })),
      };
    }),

  grab: authed
    .route({
      method: "POST",
      path: "/series/{id}/releases/grab",
      summary: "Grab a release",
      description:
        "Sends a release from the latest search of the series to qBittorrent, in the mangarr category, and starts tracking it. mangarr fetches the magnet or .torrent through Prowlarr itself, so the info-hash is always known.",
      tags,
      successStatus: 201,
    })
    .input(z.object({ id, guid: z.string().min(1) }))
    .output(downloadOutput)
    .handler(async ({ context: { db, releases }, input, signal }) => {
      requireSeries(db, input.id);
      const result = releases.get(input.id, input.guid);
      if (!result) {
        throw new ORPCError("NOT_FOUND", {
          message: `That release is not in the latest search results, which last ${releaseCacheTtlMs / 60_000} minutes. Search again.`,
        });
      }
      const { release, parsed, match } = result;
      if (release.infoHash) assertNotGrabbed(db, release.infoHash);

      // Both are checked before anything is fetched.
      const prowlarr = prowlarrFromSettings(db);
      const { client: qbittorrent, category } = qbittorrentFromSettings(db);

      const link = release.magnetUrl ?? release.downloadUrl;
      if (!link) throw new ORPCError("UNPROCESSABLE_CONTENT", { message: "The indexer gave no download link for this release" });
      const download = await prowlarr.download(link, signal);

      let infoHash: string;
      try {
        infoHash = infoHashOf(download);
      } catch (error) {
        if (error instanceof TorrentError) throw new ORPCError("UNPROCESSABLE_CONTENT", { message: error.message, cause: error });
        throw error;
      }
      assertNotGrabbed(db, infoHash);

      await qbittorrent.ensureCategory(category);
      const [present] = await qbittorrent.torrents({ hashes: [infoHash] });
      if (present) {
        throw new ORPCError("CONFLICT", {
          message: `qBittorrent already has this torrent ("${present.name}"). mangarr only tracks torrents it adds itself.`,
        });
      }
      await qbittorrent.add(download, category);

      return db
        .insert(downloads)
        .values({
          seriesId: input.id,
          infoHash,
          releaseTitle: release.title,
          indexerName: release.indexer,
          prowlarrGuid: release.guid,
          size: release.size,
          expectedVolumes: parsed.volumes,
          titleMatch: match,
        })
        .returning()
        .get();
    }),
};
