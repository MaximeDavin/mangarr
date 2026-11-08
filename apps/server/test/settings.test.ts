import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db/client";
import { ensureApiKey, getSetting, getSettings, setSetting } from "../src/settings";

describe("settings", () => {
  it("returns defaults until a value is saved", () => {
    const db = openDatabase(":memory:");
    expect(getSetting(db, "qbittorrentCategory")).toBe("mangarr");
    expect(getSetting(db, "pollIntervalSeconds")).toBe(30);
  });

  it("saves and overwrites values, keeping their type", () => {
    const db = openDatabase(":memory:");
    setSetting(db, "pollIntervalSeconds", 60);
    setSetting(db, "pollIntervalSeconds", 45);
    setSetting(db, "prowlarrUrl", "http://prowlarr:9696");

    expect(getSetting(db, "pollIntervalSeconds")).toBe(45);
    expect(getSettings(db)).toMatchObject({
      pollIntervalSeconds: 45,
      prowlarrUrl: "http://prowlarr:9696",
      qbittorrentCategory: "mangarr",
    });
  });

  it("generates the API key once and keeps it", () => {
    const db = openDatabase(":memory:");
    const key = ensureApiKey(db);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(ensureApiKey(db)).toBe(key);
  });
});
