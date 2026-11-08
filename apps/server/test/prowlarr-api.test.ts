// The Prowlarr procedures, with the global fetch standing in for Prowlarr.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { openDatabase } from "../src/db/client";
import { createFetchHandler } from "../src/http";
import { ensureApiKey, setSetting } from "../src/settings";
import { apiClient, rejection } from "./helpers";

const prowlarrKey = "0123456789abcdef0123456789abcdef";

/** Prowlarr's answers, and the requests mangarr sent it. */
function fakeProwlarr(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push(request);
    return respond(request);
  }) as typeof fetch);
  return requests;
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function setup({ configured = true } = {}) {
  const db = openDatabase(":memory:");
  const apiKey = ensureApiKey(db);
  if (configured) {
    setSetting(db, "prowlarrUrl", "http://prowlarr:9696");
    setSetting(db, "prowlarrApiKey", prowlarrKey);
  }
  return { db, apiKey, api: apiClient(db, { apiKey }) };
}

const failure = (call: Promise<unknown>) => rejection(call);

const status = () => Response.json({ appName: "Prowlarr", version: "2.1.0.5000" });

describe("prowlarr.test", () => {
  it("uses the saved settings by default", async () => {
    const { api } = setup();
    const requests = fakeProwlarr(status);
    expect(await api.prowlarr.test({})).toEqual({ version: "2.1.0.5000" });
    expect(requests[0]!.url).toBe("http://prowlarr:9696/api/v1/system/status");
    expect(requests[0]!.headers.get("x-api-key")).toBe(prowlarrKey);
  });

  it("tests the form's values before they are saved", async () => {
    const { api } = setup();
    const requests = fakeProwlarr(status);
    await api.prowlarr.test({ url: " http://other:9696/ ", apiKey: "newkey" });
    expect(requests[0]!.url).toBe("http://other:9696/api/v1/system/status");
    expect(requests[0]!.headers.get("x-api-key")).toBe("newkey");
  });

  it("keeps the saved key when the URL given is the saved one", async () => {
    const { api } = setup();
    const requests = fakeProwlarr(status);
    await api.prowlarr.test({ url: "http://prowlarr:9696/" });
    expect(requests[0]!.headers.get("x-api-key")).toBe(prowlarrKey);
  });

  it("never sends the saved key to another URL", async () => {
    const { api } = setup();
    const requests = fakeProwlarr(status);
    expect((await failure(api.prowlarr.test({ url: "http://attacker:9696" }))).code).toBe("PRECONDITION_FAILED");
    expect(requests).toHaveLength(0);
  });

  it("needs a URL and a key", async () => {
    const requests = fakeProwlarr(status);
    expect((await failure(setup({ configured: false }).api.prowlarr.test({}))).code).toBe("PRECONDITION_FAILED");
    // A cleared field is not replaced by the saved value.
    expect((await failure(setup().api.prowlarr.test({ apiKey: "" }))).code).toBe("PRECONDITION_FAILED");
    expect(requests).toHaveLength(0);
  });

  it("reports a key Prowlarr rejects as an upstream failure, not as mangarr's own 401", async () => {
    const { api } = setup();
    fakeProwlarr(() => new Response("Unauthorized", { status: 401 }));
    const error = await failure(api.prowlarr.test({}));
    expect(error.code).toBe("BAD_GATEWAY");
    expect(error.message).toBe("Prowlarr rejected the API key");
    expect(error.data).toEqual({ kind: "unauthorized" });
  });
});

describe("prowlarr.indexers", () => {
  it("lists indexers by name with their categories flattened", async () => {
    const { api } = setup();
    const requests = fakeProwlarr(() =>
      Response.json([
        {
          id: 5,
          name: "YggTorrent",
          enable: true,
          protocol: "torrent",
          privacy: "private",
          language: "fr-FR",
          capabilities: {
            categories: [
              {
                id: 7000,
                name: "Books",
                subCategories: [
                  { id: 7020, name: "Books/EBook" },
                  { id: 7030, name: "Books/Comics" },
                ],
              },
            ],
          },
        },
        { id: 3, name: "Nyaa.si", enable: true, protocol: "torrent", privacy: "public" },
      ]),
    );
    expect(await api.prowlarr.indexers()).toEqual([
      { id: 3, name: "Nyaa.si", enabled: true, protocol: "torrent", privacy: "public", categories: [] },
      {
        id: 5,
        name: "YggTorrent",
        enabled: true,
        protocol: "torrent",
        privacy: "private",
        language: "fr-FR",
        categories: [
          { id: 7000, name: "Books" },
          { id: 7020, name: "Books/EBook" },
          { id: 7030, name: "Books/Comics" },
        ],
      },
    ]);
    expect(requests[0]!.url).toBe("http://prowlarr:9696/api/v1/indexer");
  });

  it("needs Prowlarr to be configured", async () => {
    const error = await failure(setup({ configured: false }).api.prowlarr.indexers());
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.data).toEqual({ kind: "not_configured" });
  });
});

describe("over REST", () => {
  it("answers a Prowlarr failure with 502 and logs one warning line", async () => {
    const { db, apiKey } = setup();
    fakeProwlarr(() => {
      throw new TypeError("Unable to connect");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createFetchHandler(db)(
        new Request("http://mangarr/api/v1/prowlarr/indexers", { headers: { "x-api-key": apiKey } }),
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        code: "BAD_GATEWAY",
        message: "Could not reach Prowlarr at http://prowlarr:9696: Unable to connect",
        data: { kind: "unreachable" },
      });
      expect(warn).toHaveBeenCalledWith("warning: Could not reach Prowlarr at http://prowlarr:9696: Unable to connect");
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
