import { describe, expect, it } from "bun:test";
import { openDatabase, type Db } from "../src/db/client";
import { series } from "../src/db/schema";
import { ensureApiKey, getSetting } from "../src/settings";
import { apiClient, errorCode } from "./helpers";

function setup() {
  const db = openDatabase(":memory:");
  const apiKey = ensureApiKey(db);
  return { db, apiKey, api: clientFor(db, apiKey) };
}

const clientFor = (db: Db, apiKey?: string) => apiClient(db, { apiKey });

const french = { code: "fr", name: "Français", rootFolder: "/data/media/manga/fr" };

describe("API key", () => {
  it("rejects calls without the key or with a wrong one", async () => {
    const { db } = setup();
    expect(await errorCode(clientFor(db).settings.get())).toBe("UNAUTHORIZED");
    expect(await errorCode(clientFor(db, "0".repeat(32)).languages.list())).toBe("UNAUTHORIZED");
  });

  it("stops accepting the old key once regenerated", async () => {
    const { db, apiKey, api } = setup();
    const { apiKey: next } = await api.settings.regenerateApiKey();
    expect(next).toMatch(/^[0-9a-f]{32}$/);
    expect(next).not.toBe(apiKey);
    expect(await errorCode(api.settings.get())).toBe("UNAUTHORIZED");
    expect((await clientFor(db, next).settings.get()).apiKey).toBe(next);
  });
});

describe("settings", () => {
  it("never returns secrets, only whether they are set", async () => {
    const { api } = setup();
    const saved = await api.settings.update({ prowlarrApiKey: "secret", qbittorrentPassword: "hunter2" });
    expect(saved).toMatchObject({ prowlarrApiKeySet: true, qbittorrentPasswordSet: true, komgaApiKeySet: false });
    expect(JSON.stringify(saved)).not.toContain("secret");
    expect(JSON.stringify(saved)).not.toContain("hunter2");

    expect((await api.settings.update({ prowlarrApiKey: "" })).prowlarrApiKeySet).toBe(false);
  });

  it("only changes the fields it is given", async () => {
    const { db, api } = setup();
    await api.settings.update({ qbittorrentPassword: "hunter2", pollIntervalSeconds: 60 });
    const saved = await api.settings.update({ qbittorrentUsername: "admin" });
    expect(saved).toMatchObject({ qbittorrentUsername: "admin", pollIntervalSeconds: 60, qbittorrentCategory: "mangarr" });
    expect(getSetting(db, "qbittorrentPassword")).toBe("hunter2");
  });

  it("cleans URLs and rejects ones that aren't http(s)", async () => {
    const { api } = setup();
    expect((await api.settings.update({ prowlarrUrl: " http://prowlarr:9696/ " })).prowlarrUrl).toBe(
      "http://prowlarr:9696",
    );
    expect((await api.settings.update({ prowlarrUrl: "" })).prowlarrUrl).toBe("");
    expect(await errorCode(api.settings.update({ komgaUrl: "komga:25600" }))).toBe("BAD_REQUEST");
    expect(await errorCode(api.settings.update({ komgaUrl: "ftp://komga" }))).toBe("BAD_REQUEST");
  });

  it("rejects an empty category and an out-of-range poll interval", async () => {
    const { api } = setup();
    expect(await errorCode(api.settings.update({ qbittorrentCategory: "  " }))).toBe("BAD_REQUEST");
    expect(await errorCode(api.settings.update({ pollIntervalSeconds: 1 }))).toBe("BAD_REQUEST");
    expect(await errorCode(api.settings.update({ pollIntervalSeconds: 30.5 }))).toBe("BAD_REQUEST");
  });

  it("does not let the API key be set directly", async () => {
    const { apiKey, api } = setup();
    // Unknown keys are stripped by the input schema.
    await api.settings.update({ apiKey: "mine" } as never);
    expect((await api.settings.get()).apiKey).toBe(apiKey);
  });
});

describe("languages", () => {
  it("creates a language with defaults and cleans its fields", async () => {
    const { api } = setup();
    const { warnings, ...created } = await api.languages.create({ ...french, code: " FR ", rootFolder: "/data/media/manga/fr/" });
    expect(warnings).toEqual([]);
    expect(created).toEqual({
      id: expect.any(Number),
      code: "fr",
      name: "Français",
      prowlarrIndexerIds: [],
      prowlarrCategories: [],
      rootFolder: "/data/media/manga/fr",
      komgaLibraryId: null,
      komgaScanError: null,
      komgaScanErrorAt: null,
      useMangaNewsDataset: false,
    });
    expect(await api.languages.get({ id: created.id })).toEqual(created);
    expect(await api.languages.list()).toEqual([created]);
  });

  it("lists languages by name", async () => {
    const { api } = setup();
    await api.languages.create(french);
    await api.languages.create({ code: "en", name: "English", rootFolder: "/en" });
    expect((await api.languages.list()).map((l) => l.code)).toEqual(["en", "fr"]);
  });

  it("rejects invalid codes and relative root folders", async () => {
    const { api } = setup();
    expect(await errorCode(api.languages.create({ ...french, code: "french" }))).toBe("BAD_REQUEST");
    expect(await errorCode(api.languages.create({ ...french, rootFolder: "manga/fr" }))).toBe("BAD_REQUEST");
    expect(await errorCode(api.languages.create({ ...french, name: "" }))).toBe("BAD_REQUEST");
  });

  it("refuses a duplicate code, on create and on update", async () => {
    const { api } = setup();
    await api.languages.create(french);
    const en = await api.languages.create({ code: "en", name: "English", rootFolder: "/en" });
    expect(await errorCode(api.languages.create(french))).toBe("CONFLICT");
    expect(await errorCode(api.languages.update({ id: en.id, code: "fr" }))).toBe("CONFLICT");
    // Keeping its own code is fine.
    expect((await api.languages.update({ id: en.id, code: "en" })).code).toBe("en");
  });

  it("updates only the fields it is given", async () => {
    const { api } = setup();
    const { warnings, ...created } = await api.languages.create({
      ...french,
      prowlarrIndexerIds: [3, 7],
      komgaLibraryId: "0ABC",
      useMangaNewsDataset: true,
    });
    expect(warnings).toEqual(["Komga isn't set up yet, so library 0ABC wasn't checked"]);
    const updated = await api.languages.update({ id: created.id, name: "French" });
    // The library didn't change, so it isn't checked again.
    expect(updated).toEqual({ ...created, name: "French", warnings: [] });

    expect((await api.languages.update({ id: created.id, komgaLibraryId: "" })).komgaLibraryId).toBeNull();
    expect(await api.languages.update({ id: created.id })).toEqual({ ...created, name: "French", komgaLibraryId: null, warnings: [] });
    // Form state often carries explicit undefineds; they count as omitted.
    expect(await api.languages.update({ id: created.id, name: undefined })).toEqual({
      ...created,
      name: "French",
      komgaLibraryId: null,
      warnings: [],
    });
  });

  it("treats root folders as container (POSIX) paths", async () => {
    const { api } = setup();
    expect((await api.languages.create({ ...french, rootFolder: "/" })).rootFolder).toBe("/");
    expect((await api.languages.create({ code: "en", name: "English", rootFolder: "/en//" })).rootFolder).toBe("/en");
    expect(await errorCode(api.languages.create({ code: "de", name: "Deutsch", rootFolder: "C:\\manga" }))).toBe(
      "BAD_REQUEST",
    );
  });

  it("reports unknown ids as not found", async () => {
    const { api } = setup();
    expect(await errorCode(api.languages.get({ id: 99 }))).toBe("NOT_FOUND");
    expect(await errorCode(api.languages.update({ id: 99, name: "x" }))).toBe("NOT_FOUND");
    expect(await errorCode(api.languages.update({ id: 99 }))).toBe("NOT_FOUND");
    expect(await errorCode(api.languages.delete({ id: 99 }))).toBe("NOT_FOUND");
  });

  it("deletes a language, but not while it has series", async () => {
    const { db, api } = setup();
    const fr = await api.languages.create(french);
    const en = await api.languages.create({ code: "en", name: "English", rootFolder: "/en" });
    db.insert(series).values({ languageId: fr.id, mangabakaId: 1, displayTitle: "X", folderPath: "/x" }).run();

    expect(await errorCode(api.languages.delete({ id: fr.id }))).toBe("CONFLICT");
    await api.languages.delete({ id: en.id });
    expect((await api.languages.list()).map((l) => l.code)).toEqual(["fr"]);
  });
});
