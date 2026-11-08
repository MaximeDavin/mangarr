// Download procedures for the Activity screen (spec §7.4, §9): the list with live progress, one
// download with its import log, and "Retry import".

import { ORPCError } from "@orpc/server";
import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { downloadStatuses, downloads, importActions, series } from "../db/schema";
import { errorMessage } from "../errors";
import { type QBittorrentTorrent, qbittorrentFromSettings } from "../integrations/qbittorrent";
import { authed } from "./base";
import { downloadOutput } from "./releases";

const id = z.int().positive();

const seriesSummary = z.object({ id, displayTitle: z.string(), coverUrl: z.string().nullable() });

/** What qBittorrent says right now, for downloads still downloading. */
const clientState = z.object({
  state: z.string(),
  /** 0 to 1. */
  progress: z.number(),
  /** Seconds, when qBittorrent knows. */
  eta: z.number().optional(),
  /** Bytes per second. */
  downloadSpeed: z.number(),
});

const listItem = downloadOutput.extend({ series: seriesSummary, client: clientState.nullable() });

const logEntry = z.object({
  id,
  sourceFile: z.string(),
  action: z.enum(importActions),
  volumeNumber: z.number().nullable(),
  destPath: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.date(),
});

const notFound = (downloadId: number) => new ORPCError("NOT_FOUND", { message: `Download ${downloadId} not found` });

function getDownload(db: Db, downloadId: number) {
  const row = db.query.downloads
    .findFirst({
      where: { id: downloadId },
      with: {
        series: { columns: { id: true, displayTitle: true, coverUrl: true } },
        importLog: { orderBy: { id: "asc" } },
      },
    })
    .sync();
  if (!row) throw notFound(downloadId);
  return row;
}

function toClientState(torrent: QBittorrentTorrent | undefined): z.infer<typeof clientState> | null {
  if (!torrent) return null;
  const { state, progress, eta, downloadSpeed } = torrent;
  return { state, progress, eta, downloadSpeed };
}

const tags = ["Activity"];

export const downloadsRouter = {
  list: authed
    .route({
      method: "GET",
      path: "/downloads",
      summary: "List downloads",
      description:
        "Newest grabbed first, or newest imported first with `sort: imported`. `total` counts every matching download, for paging with `offset`. Downloads still downloading carry qBittorrent's live progress; when qBittorrent can't be reached, `clientError` says why and progress is left out.",
      tags,
    })
    .input(
      z.object({
        statuses: z.array(z.enum(downloadStatuses)).optional(),
        seriesId: id.optional(),
        sort: z.enum(["grabbed", "imported"]).default("grabbed"),
        limit: z.int().min(1).max(500).default(100),
        offset: z.int().min(0).default(0),
      }),
    )
    .output(z.object({ downloads: z.array(listItem), total: z.int(), clientError: z.string().nullable() }))
    .handler(async ({ context: { db }, input }) => {
      const filters: SQL[] = [];
      if (input.statuses) filters.push(inArray(downloads.status, input.statuses));
      if (input.seriesId) filters.push(eq(downloads.seriesId, input.seriesId));
      const where = filters.length > 0 ? and(...filters) : undefined;
      const rows = db
        .select({
          download: downloads,
          series: { id: series.id, displayTitle: series.displayTitle, coverUrl: series.coverUrl },
        })
        .from(downloads)
        .innerJoin(series, eq(series.id, downloads.seriesId))
        .where(where)
        .orderBy(desc(input.sort === "imported" ? downloads.importedAt : downloads.grabbedAt), desc(downloads.id))
        .limit(input.limit)
        .offset(input.offset)
        .all();
      const total = db.select({ n: count() }).from(downloads).where(where).get()?.n ?? 0;

      const active = rows.filter((r) => r.download.status === "downloading").map((r) => r.download.infoHash);
      let torrents = new Map<string, QBittorrentTorrent>();
      let clientError: string | null = null;
      if (active.length > 0) {
        try {
          const list = await qbittorrentFromSettings(db).client.torrents({ hashes: active });
          torrents = new Map(list.map((t) => [t.hash, t]));
        } catch (error) {
          clientError = errorMessage(error);
        }
      }

      return {
        total,
        clientError,
        downloads: rows.map(({ download, series: summary }) => ({
          ...download,
          series: summary,
          client: download.status === "downloading" ? toClientState(torrents.get(download.infoHash)) : null,
        })),
      };
    }),

  get: authed
    .route({ method: "GET", path: "/downloads/{id}", summary: "Get a download with its import log", tags })
    .input(z.object({ id }))
    .output(downloadOutput.extend({ series: seriesSummary, importLog: z.array(logEntry) }))
    .handler(({ context: { db }, input }) => getDownload(db, input.id)),

  retryImport: authed
    .route({
      method: "POST",
      path: "/downloads/{id}/retry-import",
      summary: "Retry the import of a download that needs attention",
      description: "Runs the import again right away, for example after adding the volume count or fixing the folder.",
      tags,
    })
    .input(z.object({ id }))
    .output(downloadOutput)
    .handler(({ context: { db, jobs }, input }) => {
      const row = db.select({ status: downloads.status }).from(downloads).where(eq(downloads.id, input.id)).get();
      if (!row) throw notFound(input.id);
      if (row.status !== "needs_attention") {
        throw new ORPCError("CONFLICT", {
          message: `Only a download that needs attention can be retried; this one is ${row.status.replaceAll("_", " ")}`,
        });
      }
      const updated = db
        .update(downloads)
        .set({ status: "importing", statusMessage: null })
        .where(eq(downloads.id, input.id))
        .returning()
        .get();
      jobs.wake();
      return updated!;
    }),
};
