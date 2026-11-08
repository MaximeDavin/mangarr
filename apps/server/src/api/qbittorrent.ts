// qBittorrent procedures for the Settings screen (spec §6.2, §9): the connection test.

import { z } from "zod";
import { createQBittorrentClient, QBittorrentError } from "../integrations/qbittorrent";
import { getSettings } from "../settings";
import { authed } from "./base";
import { savedSecretFor, serviceUrl } from "./settings";

export const qbittorrentRouter = {
  test: authed
    .route({
      method: "POST",
      path: "/qbittorrent/test",
      summary: "Test the qBittorrent connection",
      description:
        "Logs in and reads the version. Uses the given values, or the saved ones for fields left out, so the Settings form can be tested before saving. The saved password is only sent to the saved URL.",
      tags: ["qBittorrent"],
    })
    .input(
      z.object({ url: serviceUrl.optional(), username: z.string().trim().optional(), password: z.string().optional() }),
    )
    .output(z.object({ version: z.string() }))
    .handler(async ({ context, input }) => {
      const saved = getSettings(context.db);
      const url = input.url ?? saved.qbittorrentUrl;
      if (!url) throw new QBittorrentError("not_configured", "Give the qBittorrent URL");
      const client = createQBittorrentClient({
        url,
        username: input.username ?? saved.qbittorrentUsername,
        password: input.password ?? savedSecretFor(url, saved.qbittorrentUrl, saved.qbittorrentPassword),
      });
      return { version: await client.version() };
    }),
};
