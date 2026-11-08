import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db/client";
import {
  createProwlarrClient,
  type Fetch,
  ProwlarrError,
  prowlarrFromSettings,
} from "../src/integrations/prowlarr";
import { normalizeInfoHash } from "../src/integrations/torrent";
import { setSetting } from "../src/settings";
import { rejection } from "./helpers";

const apiKey = "0123456789abcdef0123456789abcdef";

/** A client whose fetch answers with `respond` and records every request. */
function setup(respond: (request: Request) => Response | Promise<Response>, url = "http://prowlarr:9696/") {
  const requests: Request[] = [];
  const fetch: Fetch = async (request) => {
    requests.push(request);
    return respond(request);
  };
  return { requests, prowlarr: createProwlarrClient({ url, apiKey, fetch, timeoutMs: 50, searchTimeoutMs: 50 }) };
}

const failure = (call: Promise<unknown>) => rejection(call, ProwlarrError);

/** Waits until the request is aborted, like a server that never answers. */
const hang = (request: Request) =>
  new Promise<Response>((_, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason));
  });

// Trimmed from a real nyaa result. Prowlarr leaves null fields out.
const nyaaRelease = {
  guid: "https://nyaa.si/view/1234567",
  age: 12,
  size: 1_288_490_189,
  files: 20,
  grabs: 310,
  indexerId: 3,
  indexer: "Nyaa.si",
  title: "One Piece v01-20 (2003-2008) (Digital) (1r0n)",
  sortTitle: "one piece v01 20 2003 2008 digital 1r0n",
  publishDate: "2024-03-01T10:20:30Z",
  downloadUrl: `http://prowlarr:9696/3/download?apikey=${apiKey}&link=abc&file=One+Piece`,
  infoUrl: "https://nyaa.si/view/1234567",
  categories: [{ id: 7030, name: "Books/Comics", subCategories: [] }],
  magnetUrl: `http://prowlarr:9696/3/download?apikey=${apiKey}&link=def&file=One+Piece`,
  infoHash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
  seeders: 42,
  leechers: 3,
  protocol: "torrent",
  fileName: "One Piece v01-20 (2003-2008) (Digital) (1r0n).torrent",
};

describe("search", () => {
  it("sends the query, indexers and categories, with the key in a header", async () => {
    const { requests, prowlarr } = setup(() => Response.json([]), "http://host/prowlarr/");
    await prowlarr.search({ query: "one piece", indexerIds: [3, 5], categories: [7030] });

    const [request] = requests;
    const url = new URL(request!.url);
    expect(url.origin + url.pathname).toBe("http://host/prowlarr/api/v1/search");
    expect(url.searchParams.get("query")).toBe("one piece");
    expect(url.searchParams.get("type")).toBe("search");
    expect(url.searchParams.getAll("indexerIds")).toEqual(["3", "5"]);
    expect(url.searchParams.getAll("categories")).toEqual(["7030"]);
    expect(url.searchParams.has("limit")).toBe(false);
    expect(request!.headers.get("x-api-key")).toBe(apiKey);
    expect(request!.url).not.toContain(apiKey);
  });

  it("refuses to search with no indexers, since Prowlarr would search all of them", async () => {
    const { requests, prowlarr } = setup(() => Response.json([]));
    await expect(prowlarr.search({ query: "berserk", indexerIds: [] })).rejects.toThrow("at least one indexer");
    expect(requests).toHaveLength(0);
  });

  it("maps the fields mangarr uses", async () => {
    const { prowlarr } = setup(() => Response.json([nyaaRelease]));
    expect(await prowlarr.search({ query: "one piece", indexerIds: [3] })).toEqual([
      {
        guid: "https://nyaa.si/view/1234567",
        title: "One Piece v01-20 (2003-2008) (Digital) (1r0n)",
        size: 1_288_490_189,
        indexerId: 3,
        indexer: "Nyaa.si",
        protocol: "torrent",
        publishDate: Date.UTC(2024, 2, 1, 10, 20, 30),
        downloadUrl: nyaaRelease.downloadUrl,
        magnetUrl: nyaaRelease.magnetUrl,
        infoHash: "abcdef0123456789abcdef0123456789abcdef01",
        seeders: 42,
        leechers: 3,
        infoUrl: "https://nyaa.si/view/1234567",
      },
    ]);
  });

  it("leaves out what the indexer didn't give", async () => {
    const sparse = { guid: "x-1", title: "Berserk T01", indexerId: 7, protocol: "torrent", publishDate: "garbage" };
    const { prowlarr } = setup(() => Response.json([sparse]));
    const [release] = await prowlarr.search({ query: "berserk", indexerIds: [7] });
    expect(release).toEqual({ guid: "x-1", title: "Berserk T01", size: 0, indexerId: 7, indexer: "Indexer 7", protocol: "torrent" });
  });

  it("skips results with an unexpected shape and keeps the rest", async () => {
    const { prowlarr } = setup(() => Response.json([{ title: "no guid", indexerId: 3 }, nyaaRelease, null]));
    const releases = await prowlarr.search({ query: "one piece", indexerIds: [3] });
    expect(releases.map((r) => r.guid)).toEqual([nyaaRelease.guid]);
  });

  it("reads an unknown protocol as unknown", async () => {
    const { prowlarr } = setup(() => Response.json([{ ...nyaaRelease, protocol: "ipfs" }]));
    expect((await prowlarr.search({ query: "x", indexerIds: [3] }))[0]?.protocol).toBe("unknown");
  });
});

describe("indexers", () => {
  it("lists indexers with their category tree", async () => {
    const { requests, prowlarr } = setup(() =>
      Response.json([
        {
          id: 3,
          name: "Nyaa.si",
          enable: true,
          protocol: "torrent",
          privacy: "public",
          priority: 25,
          language: "en-US",
          definitionName: "nyaasi",
          fields: [],
          tags: [],
          capabilities: {
            supportsRawSearch: false,
            categories: [{ id: 7000, name: "Books", subCategories: [{ id: 7030, name: "Books/Comics" }] }],
          },
        },
        { id: 9, name: "Old usenet", enable: false, protocol: "usenet" },
      ]),
    );
    expect(await prowlarr.indexers()).toEqual([
      {
        id: 3,
        name: "Nyaa.si",
        enabled: true,
        protocol: "torrent",
        privacy: "public",
        priority: 25,
        language: "en-US",
        categories: [{ id: 7000, name: "Books", subCategories: [{ id: 7030, name: "Books/Comics", subCategories: [] }] }],
      },
      { id: 9, name: "Old usenet", enabled: false, protocol: "usenet", categories: [] },
    ]);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/indexer");
  });
});

describe("status", () => {
  it("returns the version", async () => {
    const { prowlarr } = setup(() => Response.json({ appName: "Prowlarr", instanceName: "Prowlarr", version: "2.1.0.5000" }));
    expect(await prowlarr.status()).toEqual({ version: "2.1.0.5000" });
  });

  it("notices when the URL points at another *arr app", async () => {
    const { prowlarr } = setup(() => Response.json({ appName: "Lidarr", version: "2.0.0" }));
    const error = await failure(prowlarr.status());
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toContain("Lidarr");
  });
});

describe("errors", () => {
  it("reports a rejected API key", async () => {
    const { prowlarr } = setup(() => new Response("Unauthorized", { status: 401 }));
    const error = await failure(prowlarr.indexers());
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
  });

  it("passes on Prowlarr's error message", async () => {
    const { prowlarr } = setup(() => Response.json({ message: "Search failed: indexer timed out" }, { status: 400 }));
    const error = await failure(prowlarr.search({ query: "x", indexerIds: [1] }));
    expect(error).toMatchObject({ kind: "http", status: 400 });
    expect(error.message).toBe("Prowlarr answered 400: Search failed: indexer timed out");
  });

  it("passes on validation messages", async () => {
    const { prowlarr } = setup(() =>
      Response.json([{ propertyName: "Query", errorMessage: "Query is required" }], { status: 400 }),
    );
    expect((await failure(prowlarr.search({ query: "", indexerIds: [1] }))).message).toContain("Query is required");
  });

  it("reports a page that isn't JSON as a wrong URL", async () => {
    const { prowlarr } = setup(() => new Response("<!doctype html><title>Komga</title>", { status: 200 }));
    const error = await failure(prowlarr.status());
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toContain("Check the URL");
  });

  it("reports a JSON body of the wrong shape", async () => {
    const { prowlarr } = setup(() => Response.json({ records: [] }));
    expect((await failure(prowlarr.search({ query: "x", indexerIds: [1] }))).kind).toBe("invalid_response");
  });

  it("reports an unreachable server without leaking the key", async () => {
    const { prowlarr } = setup(() => {
      throw new TypeError("Unable to connect");
    });
    const error = await failure(prowlarr.status());
    expect(error.kind).toBe("unreachable");
    expect(error.message).toBe("Could not reach Prowlarr at http://prowlarr:9696: Unable to connect");
  });

  it("times out", async () => {
    const { prowlarr } = setup(hang);
    expect((await failure(prowlarr.search({ query: "x", indexerIds: [1] }))).kind).toBe("timeout");
  });

  it("lets the caller's abort through unchanged", async () => {
    const { prowlarr } = setup(hang);
    const controller = new AbortController();
    const call = prowlarr.indexers(controller.signal);
    controller.abort(new Error("user closed the modal"));
    await expect(call).rejects.toThrow("user closed the modal");
  });
});

describe("normalizeInfoHash", () => {
  it("lowercases hex and converts base32", () => {
    expect(normalizeInfoHash(" ABCDEF0123456789ABCDEF0123456789ABCDEF01 ")).toBe("abcdef0123456789abcdef0123456789abcdef01");
    // Base32 of 0x00…00 followed by 0xff…ff halves.
    expect(normalizeInfoHash("AAAAAAAAAAAAAAAA7777777777777777")).toBe("00000000000000000000ffffffffffffffffffff");
    expect(normalizeInfoHash("mfrggzdfmztwq2lknnwg23tpobyxe43u")).toBe(
      Buffer.from("abcdefghijklmnopqrst").toString("hex"),
    );
  });

  it("rejects anything else", () => {
    expect(normalizeInfoHash(undefined)).toBeUndefined();
    expect(normalizeInfoHash("")).toBeUndefined();
    expect(normalizeInfoHash("abc")).toBeUndefined();
    // A v2 (SHA-256) hash.
    expect(normalizeInfoHash("a".repeat(64))).toBeUndefined();
  });
});

describe("prowlarrFromSettings", () => {
  it("needs both the URL and the API key", () => {
    const db = openDatabase(":memory:");
    expect(() => prowlarrFromSettings(db)).toThrow(ProwlarrError);
    setSetting(db, "prowlarrUrl", "http://prowlarr:9696");
    expect(() => prowlarrFromSettings(db)).toThrow("Prowlarr URL and API key");
    setSetting(db, "prowlarrApiKey", apiKey);
    expect(prowlarrFromSettings(db)).toBeDefined();
  });

  it("uses the saved settings", async () => {
    const db = openDatabase(":memory:");
    setSetting(db, "prowlarrUrl", "http://prowlarr:9696");
    setSetting(db, "prowlarrApiKey", apiKey);
    const requests: Request[] = [];
    const prowlarr = prowlarrFromSettings(db, async (request) => {
      requests.push(request);
      return Response.json({ appName: "Prowlarr", version: "2.1.0" });
    });
    await prowlarr.status();
    expect(requests[0]!.url).toBe("http://prowlarr:9696/api/v1/system/status");
    expect(requests[0]!.headers.get("x-api-key")).toBe(apiKey);
  });
});
