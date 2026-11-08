// Settings procedures (spec §4.8).
// Passwords and third-party API keys are write-only: reads only say whether each one is set.

import { z } from "zod";
import { generateApiKey, getSettings, setSetting, type SettingKey, type Settings } from "../settings";
import { authed } from "./base";

/** An http(s) URL without trailing slashes, or "" when not configured. */
export const serviceUrl = z
  .string()
  .trim()
  .transform((value) => value.replace(/\/+$/, ""))
  .pipe(z.union([z.literal(""), z.url({ protocol: /^https?$/ })]));

/**
 * A saved key or password, but only for the URL it was saved with (spec §8). Otherwise "": a
 * connection test pointed at another server must bring its own, or it would hand ours over.
 */
export function savedSecretFor(url: string, savedUrl: string, secret: string): string {
  return url === savedUrl ? secret : "";
}

const settingsOutput = z.object({
  prowlarrUrl: z.string(),
  prowlarrApiKeySet: z.boolean(),
  qbittorrentUrl: z.string(),
  qbittorrentUsername: z.string(),
  qbittorrentPasswordSet: z.boolean(),
  qbittorrentCategory: z.string(),
  komgaUrl: z.string(),
  komgaApiKeySet: z.boolean(),
  mangaNewsCsvUrl: z.string(),
  pollIntervalSeconds: z.number(),
  /** The caller already knows it, and the Settings screen shows it for scripts. */
  apiKey: z.string(),
});

/** Omitted fields keep their value. "" clears a URL or secret. */
const settingsInput = z
  .object({
    prowlarrUrl: serviceUrl,
    prowlarrApiKey: z.string().trim(),
    qbittorrentUrl: serviceUrl,
    qbittorrentUsername: z.string().trim(),
    qbittorrentPassword: z.string(),
    qbittorrentCategory: z.string().trim().min(1),
    komgaUrl: serviceUrl,
    komgaApiKey: z.string().trim(),
    mangaNewsCsvUrl: serviceUrl,
    pollIntervalSeconds: z.int().min(5).max(3600),
  })
  .partial() satisfies z.ZodType<Partial<Settings>>;

function toOutput(all: Settings): z.infer<typeof settingsOutput> {
  const { prowlarrApiKey, qbittorrentPassword, komgaApiKey, ...rest } = all;
  return {
    ...rest,
    prowlarrApiKeySet: prowlarrApiKey !== "",
    qbittorrentPasswordSet: qbittorrentPassword !== "",
    komgaApiKeySet: komgaApiKey !== "",
  };
}

export const settingsRouter = {
  get: authed
    .route({ method: "GET", path: "/settings", summary: "Get settings", tags: ["Settings"] })
    .output(settingsOutput)
    .handler(({ context }) => toOutput(getSettings(context.db))),

  update: authed
    .route({ method: "PATCH", path: "/settings", summary: "Update settings", tags: ["Settings"] })
    .input(settingsInput)
    .output(settingsOutput)
    .handler(({ context, input }) => {
      context.db.transaction((tx) => {
        for (const [key, value] of Object.entries(input) as [SettingKey, Settings[SettingKey]][]) {
          if (value !== undefined) setSetting(tx, key, value);
        }
      });
      return toOutput(getSettings(context.db));
    }),

  regenerateApiKey: authed
    .route({
      method: "POST",
      path: "/settings/api-key/regenerate",
      summary: "Replace the mangarr API key",
      description: "The old key stops working immediately.",
      tags: ["Settings"],
    })
    .output(z.object({ apiKey: z.string() }))
    .handler(({ context }) => {
      const apiKey = generateApiKey();
      setSetting(context.db, "apiKey", apiKey);
      return { apiKey };
    }),
};
