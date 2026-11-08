// The API over real HTTP requests: /rpc through the oRPC client, /api/v1 as plain REST.

import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db/client";
import { createFetchHandler } from "../src/http";
import { ensureApiKey } from "../src/settings";
import { overHttp } from "./helpers";
import { recorded, replayedMangaBaka } from "./mangabaka-replay";

function setup() {
  const db = openDatabase(":memory:");
  const apiKey = ensureApiKey(db);
  const handle = createFetchHandler(db, replayedMangaBaka().mangabaka);
  return { db, handle, ...overHttp(handle, { "x-api-key": apiKey }) };
}

const french = { code: "fr", name: "Français", rootFolder: "/data/media/manga/fr" };

describe("/rpc", () => {
  it("serves the typed client", async () => {
    const { rpc } = setup();
    const { warnings, ...created } = await rpc.languages.create(french);
    expect(warnings).toEqual([]);
    expect(await rpc.languages.get({ id: created.id })).toEqual(created);
  });

  it("needs the API key", async () => {
    const { handle } = setup();
    const response = await handle(
      new Request("http://mangarr/rpc/settings/get", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("/api/v1", () => {
  it("needs the API key", async () => {
    const { rest } = setup();
    expect((await rest("/api/v1/settings", { headers: { "x-api-key": "" } })).status).toBe(401);
    expect((await rest("/api/v1/settings")).status).toBe(200);
  });

  it("creates, reads, updates and deletes a language", async () => {
    const { rest } = setup();

    const created = await rest("/api/v1/languages", { method: "POST", body: JSON.stringify(french) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };

    // The id comes in as a string from the path and is coerced to a number.
    const got = await rest(`/api/v1/languages/${id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id, code: "fr" });

    const patched = await rest(`/api/v1/languages/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ prowlarrIndexerIds: [3, 7] }),
    });
    expect(await patched.json()).toMatchObject({ id, name: "Français", prowlarrIndexerIds: [3, 7] });

    expect((await rest(`/api/v1/languages/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await rest(`/api/v1/languages/${id}`)).status).toBe(404);
  });

  it("answers invalid input with 400 and duplicates with 409", async () => {
    const { rest } = setup();
    const post = (body: unknown) => rest("/api/v1/languages", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ ...french, rootFolder: "relative" })).status).toBe(400);
    expect((await post(french)).status).toBe(201);
    const duplicate = await post(french);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ message: 'A language with code "fr" already exists' });
    expect((await rest("/api/v1/languages/abc")).status).toBe(400);
  });

  it("routes /series/draft and /series/{id} apart, with query parameters coerced", async () => {
    const { rest } = setup();
    const created = await rest("/api/v1/languages", { method: "POST", body: JSON.stringify(french) });
    const { id: languageId } = (await created.json()) as { id: number };

    const draft = await rest(`/api/v1/series/draft?mangabakaId=${recorded.blueLock}&languageId=${languageId}`);
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({ mangabakaId: recorded.blueLock, displayTitle: "Blue Lock" });
    expect((await rest("/api/v1/series/123")).status).toBe(404);
  });

  it("answers MangaBaka not found with 404", async () => {
    const { rest } = setup();
    const created = await rest("/api/v1/languages", { method: "POST", body: JSON.stringify(french) });
    const { id: languageId } = (await created.json()) as { id: number };
    const response = await rest(`/api/v1/series/draft?mangabakaId=${recorded.missing}&languageId=${languageId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ data: { kind: "not_found" } });
  });

  it("updates settings with PATCH", async () => {
    const { rest } = setup();
    const response = await rest("/api/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({ prowlarrUrl: "http://prowlarr:9696/", prowlarrApiKey: "secret" }),
    });
    expect(await response.json()).toMatchObject({ prowlarrUrl: "http://prowlarr:9696", prowlarrApiKeySet: true });
  });
});

describe("/api/v1/openapi.json", () => {
  it("is served without a key and documents every procedure", async () => {
    const { handle } = setup();
    const response = await handle(new Request("http://mangarr/api/v1/openapi.json"));
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: unknown };
    };
    const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual([
      "DELETE /languages/{id}",
      "DELETE /series/{id}",
      "GET /auth/status",
      "GET /downloads",
      "GET /downloads/{id}",
      "GET /komga/libraries",
      "GET /languages",
      "GET /languages/{id}",
      "GET /languages/{id}/folders",
      "GET /manga-news",
      "GET /manga-news/search",
      "GET /mangabaka/search",
      "GET /prowlarr/indexers",
      "GET /series",
      "GET /series/draft",
      "GET /series/{id}",
      "GET /series/{id}/releases",
      "GET /settings",
      "PATCH /languages/{id}",
      "PATCH /series/{id}",
      "PATCH /settings",
      "POST /auth/login",
      "POST /auth/logout",
      "POST /auth/password",
      "POST /auth/setup",
      "POST /downloads/{id}/retry-import",
      "POST /komga/test",
      "POST /languages",
      "POST /manga-news/refresh",
      "POST /prowlarr/test",
      "POST /qbittorrent/test",
      "POST /series",
      "POST /series/{id}/refresh-metadata",
      "POST /series/{id}/releases/grab",
      "POST /series/{id}/rescan",
      "POST /series/{id}/search-terms",
      "POST /settings/api-key/regenerate",
      "PUT /series/{id}/search-terms",
    ]);
    expect(spec.components.securitySchemes).toEqual({
      apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
    });
  });
});

it("answers unknown paths with 404", async () => {
  const { handle } = setup();
  expect((await handle(new Request("http://mangarr/nope"))).status).toBe(404);
});
