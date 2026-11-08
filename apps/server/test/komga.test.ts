// The Komga client (spec §6.3) and its Settings procedures, against a fake fetch.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { openDatabase } from "../src/db/client";
import { languages } from "../src/db/schema";
import { createKomgaClient, KomgaError } from "../src/integrations/komga";
import type { Fetch } from "../src/integrations/upstream";
import { ensureApiKey, setSetting } from "../src/settings";
import { apiClient, errorCode, rejection } from "./helpers";

const apiKey = "komga-api-key";

// Trimmed from Komga 1.x's LibraryDto.
const libraries = [
  { id: "0FRA", name: "Manga FR", root: "/data/media/manga/fr", importComicInfoBook: true, scanInterval: "EVERY_6H", unavailable: false },
  { id: "0ENG", name: "Manga EN", root: "/data/media/manga/en", importComicInfoBook: true, scanInterval: "EVERY_6H", unavailable: false },
];

function setup(respond: (request: Request) => Response | Promise<Response>, url = "http://komga:25600/") {
  const requests: Request[] = [];
  const fetch: Fetch = async (request) => {
    requests.push(request);
    return respond(request);
  };
  return { requests, komga: createKomgaClient({ url, apiKey, fetch, timeoutMs: 50 }) };
}

const failure = (call: Promise<unknown>) => rejection(call, KomgaError);

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("libraries", () => {
  it("sends the key in X-API-Key and keeps id, name and root", async () => {
    const { requests, komga } = setup(() => Response.json(libraries), "http://host/komga/");
    expect(await komga.libraries()).toEqual([
      { id: "0FRA", name: "Manga FR", root: "/data/media/manga/fr" },
      { id: "0ENG", name: "Manga EN", root: "/data/media/manga/en" },
    ]);
    const [request] = requests;
    expect(request!.method).toBe("GET");
    expect(request!.url).toBe("http://host/komga/api/v1/libraries");
    expect(request!.headers.get("x-api-key")).toBe(apiKey);
  });

  it("names a wrong key, a page that isn't Komga, and an unreachable server", async () => {
    expect((await failure(setup(() => new Response(null, { status: 401 })).komga.libraries())).kind).toBe("unauthorized");

    const html = await failure(setup(() => new Response("<html>login</html>")).komga.libraries());
    expect(html.kind).toBe("invalid_response");
    expect(html.message).toContain("not JSON");

    const shape = await failure(setup(() => Response.json({ content: [] })).komga.libraries());
    expect(shape.kind).toBe("invalid_response");

    const down = await failure(
      setup(() => {
        throw new TypeError("connect ECONNREFUSED");
      }).komga.libraries(),
    );
    expect(down.kind).toBe("unreachable");
    expect(down.message).toContain("http://komga:25600");
  });

  it("times out", async () => {
    const hang = (request: Request) =>
      new Promise<Response>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)));
    expect((await failure(setup(hang).komga.libraries())).kind).toBe("timeout");
  });
});

describe("scanLibrary", () => {
  it("posts to the library's scan endpoint", async () => {
    const { requests, komga } = setup(() => new Response(null, { status: 202 }));
    await komga.scanLibrary("0FRA");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST http://komga:25600/api/v1/libraries/0FRA/scan"]);
  });

  it("says when the library is unknown, or the key's user is not an admin", async () => {
    const missing = await failure(setup(() => new Response(null, { status: 404 })).komga.scanLibrary("0GONE"));
    expect(missing.kind).toBe("not_found");
    expect(missing.message).toBe("Komga has no library 0GONE");

    const forbidden = await failure(setup(() => new Response(null, { status: 403 })).komga.scanLibrary("0FRA"));
    expect(forbidden.kind).toBe("unauthorized");
    expect(forbidden.message).toContain("admin");

    const broken = await failure(setup(() => Response.json({ message: "Library is unavailable" }, { status: 500 })).komga.scanLibrary("0FRA"));
    expect(broken.message).toBe("Komga answered 500: Library is unavailable");
  });
});

/**
 * A Komga at http://komga:25600 answering through the global fetch: the library list, one
 * library, and the key's user. `roles` can change between calls; any other key gets a 401.
 */
function serveKomga({ key = apiKey, roles = ["ADMIN", "USER"] } = {}) {
  const state = { roles, paths: [] as string[] };
  spyOn(globalThis, "fetch").mockImplementation((async (request: Request) => {
    const { pathname } = new URL(request.url);
    state.paths.push(`${request.method} ${pathname}`);
    if (request.headers.get("x-api-key") !== key) return new Response(null, { status: 401 });
    if (pathname === "/api/v1/libraries") return Response.json(libraries);
    if (pathname === "/api/v2/users/me") return Response.json({ id: "0USER", email: "a@b.c", roles: state.roles });
    const library = libraries.find((l) => pathname === `/api/v1/libraries/${l.id}`);
    return library ? Response.json(library) : Response.json({ status: 404, message: "404 NOT_FOUND" }, { status: 404 });
  }) as typeof globalThis.fetch);
  return state;
}

describe("me and library", () => {
  it("reads the key's roles", async () => {
    const admin = setup(() => Response.json({ id: "0U", roles: ["ADMIN", "USER"], sharedAllLibraries: true }));
    expect(await admin.komga.me()).toEqual({ roles: ["ADMIN", "USER"], isAdmin: true });
    expect(admin.requests[0]!.url).toBe("http://komga:25600/api/v2/users/me");
    expect((await setup(() => Response.json({ roles: ["USER"] })).komga.me()).isAdmin).toBe(false);
  });

  it("gets one library, and names a missing one", async () => {
    const { requests, komga } = setup(() => Response.json(libraries[0]));
    expect(await komga.library("0FRA")).toEqual({ id: "0FRA", name: "Manga FR", root: "/data/media/manga/fr" });
    expect(requests[0]!.url).toBe("http://komga:25600/api/v1/libraries/0FRA");
    const missing = await failure(setup(() => new Response(null, { status: 404 })).komga.library("0GONE"));
    expect(missing.message).toBe("Komga has no library 0GONE");
  });
});

describe("language Komga check", () => {
  function setupWithKomga() {
    const db = openDatabase(":memory:");
    const client = apiClient(db, { apiKey: ensureApiKey(db) });
    setSetting(db, "komgaUrl", "http://komga:25600");
    setSetting(db, "komgaApiKey", apiKey);
    return { db, api: client };
  }
  const french = { code: "fr", name: "French", rootFolder: "/data/media/manga/fr" };

  it("refuses an unknown library and saves nothing", async () => {
    const { api } = setupWithKomga();
    serveKomga();
    const error = await rejection(api.languages.create({ ...french, komgaLibraryId: "0GONE" }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Komga has no library 0GONE");
    expect(await api.languages.list()).toEqual([]);
  });

  it("accepts a root folder inside the library's folder, or the folder itself", async () => {
    const { api } = setupWithKomga();
    serveKomga();
    expect((await api.languages.create({ ...french, komgaLibraryId: "0FRA" })).warnings).toEqual([]);
    expect((await api.languages.create({ code: "en", name: "English", rootFolder: "/data/media/manga/en/series", komgaLibraryId: "0ENG" })).warnings).toEqual([]);
  });

  it("warns, but saves, when the root folder is outside the library's folder", async () => {
    const { api } = setupWithKomga();
    serveKomga();
    // "/data/media/manga/fr" is not inside "/data/media/manga/en", nor is "/data/media/manga/english".
    const created = await api.languages.create({ ...french, komgaLibraryId: "0ENG" });
    expect(created.komgaLibraryId).toBe("0ENG");
    expect(created.warnings).toEqual([
      'The root folder /data/media/manga/fr is not inside the Komga library "Manga EN" (/data/media/manga/en), so Komga won\'t see imported volumes. Both containers must use the same paths.',
    ]);
    const english = await api.languages.create({ code: "en", name: "English", rootFolder: "/data/media/manga/english", komgaLibraryId: "0ENG" });
    expect(english.warnings).toHaveLength(1);
  });

  it("warns, but saves, when Komga can't be asked", async () => {
    const { api } = setupWithKomga();
    serveKomga({ key: "another-key" });
    const created = await api.languages.create({ ...french, komgaLibraryId: "0FRA" });
    expect(created.warnings).toEqual(["Could not check the Komga library: Komga rejected the API key"]);
  });

  it("checks again when the library or the root folder changes, and a new library clears the last scan error", async () => {
    const { db, api } = setupWithKomga();
    const komga = serveKomga();
    const { id } = await api.languages.create({ ...french, komgaLibraryId: "0FRA" });
    db.update(languages).set({ komgaScanError: "Komga rejected the API key", komgaScanErrorAt: new Date() }).run();

    komga.paths = [];
    await api.languages.update({ id, name: "Français" });
    expect(komga.paths).toEqual([]);
    expect((await api.languages.get({ id })).komgaScanError).toBe("Komga rejected the API key");

    expect((await api.languages.update({ id, rootFolder: "/elsewhere" })).warnings).toHaveLength(1);
    expect((await api.languages.get({ id })).komgaScanError).toBe("Komga rejected the API key");

    const moved = await api.languages.update({ id, rootFolder: "/data/media/manga/en", komgaLibraryId: "0ENG" });
    expect(moved).toMatchObject({ komgaLibraryId: "0ENG", komgaScanError: null, komgaScanErrorAt: null, warnings: [] });
    expect(await errorCode(api.languages.update({ id, komgaLibraryId: "0GONE" }))).toBe("BAD_REQUEST");
    expect((await api.languages.get({ id })).komgaLibraryId).toBe("0ENG");
  });
});

describe("komga procedures", () => {
  function api() {
    const db = openDatabase(":memory:");
    const key = ensureApiKey(db);
    return { db, api: apiClient(db, { apiKey: key }) };
  }

  it("tests the given URL and key before they are saved, and says whether the key may scan", async () => {
    const { api: client } = api();
    const komga = serveKomga({ key: "typed-key" });
    const result = await client.komga.test({ url: "http://komga:25600/", apiKey: "typed-key" });
    expect(result).toEqual({ libraries: expect.any(Array), canScan: true });
    expect(result.libraries.map((l) => l.id)).toEqual(["0FRA", "0ENG"]);
    expect(komga.paths).toEqual(["GET /api/v1/libraries", "GET /api/v2/users/me"]);

    komga.roles = ["USER", "PAGE_STREAMING"];
    expect((await client.komga.test({ url: "http://komga:25600", apiKey: "typed-key" })).canScan).toBe(false);
  });

  it("needs a URL and key", async () => {
    const { api: client } = api();
    expect(await errorCode(client.komga.test({}))).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.komga.libraries())).toBe("PRECONDITION_FAILED");
  });

  it("never sends the saved key to another URL", async () => {
    const { db, api: client } = api();
    setSetting(db, "komgaUrl", "http://komga:25600");
    setSetting(db, "komgaApiKey", "saved-key");
    const komga = serveKomga({ key: "saved-key" });
    expect(await errorCode(client.komga.test({ url: "http://attacker:25600" }))).toBe("PRECONDITION_FAILED");
    expect(komga.paths).toEqual([]);
    expect((await client.komga.test({ url: "http://komga:25600" })).canScan).toBe(true);
  });

  it("lists the saved Komga's libraries by name, and reports a wrong key as a gateway error", async () => {
    const { db, api: client } = api();
    setSetting(db, "komgaUrl", "http://komga:25600");
    setSetting(db, "komgaApiKey", apiKey);
    spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(libraries)) as unknown as typeof globalThis.fetch);
    expect((await client.komga.libraries()).map((l) => l.name)).toEqual(["Manga EN", "Manga FR"]);

    (globalThis.fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async () => new Response(null, { status: 401 }),
    );
    expect(await errorCode(client.komga.libraries())).toBe("BAD_GATEWAY");
  });
});
