// Typed access to the key/value settings table (spec §4.8).

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { settings } from "./db/schema";

/** Every setting, with the value used until it is saved. */
export const settingDefaults = {
  prowlarrUrl: "",
  prowlarrApiKey: "",
  qbittorrentUrl: "",
  qbittorrentUsername: "",
  qbittorrentPassword: "",
  qbittorrentCategory: "mangarr",
  komgaUrl: "",
  komgaApiKey: "",
  /** data.gouv.fr's link to the latest version of the dataset's CSV (spec §6.5). */
  mangaNewsCsvUrl: "https://www.data.gouv.fr/api/1/datasets/r/964ffe25-8a20-4402-91de-3566ffe66660",
  pollIntervalSeconds: 30,
  /** Generated on first start by `ensureApiKey`. */
  apiKey: "",
};

export type Settings = typeof settingDefaults;
export type SettingKey = keyof Settings;

export function getSetting<K extends SettingKey>(db: Db, key: K): Settings[K] {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (row.value as Settings[K]) : settingDefaults[key];
}

export function getSettings(db: Db): Settings {
  const stored = Object.fromEntries(
    db
      .select()
      .from(settings)
      .all()
      .map((row) => [row.key, row.value]),
  );
  return { ...settingDefaults, ...stored };
}

/** Also accepts a transaction, since it only needs `insert`. */
export function setSetting<K extends SettingKey>(db: Pick<Db, "insert">, key: K, value: Settings[K]): void {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/** 32 hex characters, like the *arr apps. */
export function generateApiKey(): string {
  return randomBytes(16).toString("hex");
}

/** Returns the API key, generating and saving one on first start. */
export function ensureApiKey(db: Db): string {
  const existing = getSetting(db, "apiKey");
  if (existing) return existing;
  const key = generateApiKey();
  setSetting(db, "apiKey", key);
  return key;
}
