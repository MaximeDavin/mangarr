// The qBittorrent client against a fake Web API, and the connection test procedure.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { openDatabase } from "../src/db/client";
import { createQBittorrentClient, QBittorrentError } from "../src/integrations/qbittorrent";
import { ensureApiKey, setSetting } from "../src/settings";
import { apiClient, rejection } from "./helpers";
import { fakeQBittorrent } from "./fake-qbittorrent";

function client(fake = fakeQBittorrent(), overrides: { password?: string } = {}) {
  return {
    fake,
    qbit: createQBittorrentClient({ url: fake.url, username: fake.username, password: overrides.password ?? fake.password, fetch: fake.fetch }),
  };
}

describe("qBittorrent client", () => {
  it("logs in once and sends the session cookie, whatever its name", async () => {
    const { fake, qbit } = client(fakeQBittorrent({ cookieName: "SID" }));
    expect(await qbit.version()).toBe("v5.1.2");
    expect(await qbit.version()).toBe("v5.1.2");
    expect(fake.state.logins).toBe(1);
    expect(fake.state.requests[0]!.headers.get("referer")).toBe(fake.url);
  });

  it("accepts qBittorrent 5.3's empty 204 login answer", async () => {
    const { fake, qbit } = client(fakeQBittorrent({ emptyLogin: true, cookieName: "QBT_SID_8081" }));
    expect(await qbit.version()).toBe("v5.1.2");
    expect(fake.state.logins).toBe(1);
  });

  it("logs in again when the session expires", async () => {
    const { fake, qbit } = client();
    await qbit.version();
    fake.expireSessions();
    expect(await qbit.version()).toBe("v5.1.2");
    expect(fake.state.logins).toBe(2);
  });

  it("works without a cookie when qBittorrent skips authentication", async () => {
    const { fake, qbit } = client(fakeQBittorrent({ bypassAuth: true }));
    await qbit.version();
    await qbit.version();
    expect(fake.state.logins).toBe(1);
  });

  it("reports wrong credentials", async () => {
    const error = await rejection(client(undefined, { password: "wrong" }).qbit.version(), QBittorrentError);
    expect(error.kind).toBe("unauthorized");
    expect(error.message).toBe("qBittorrent rejected the username or password");
  });

  it("reports a URL that isn't qBittorrent", async () => {
    const qbit = createQBittorrentClient({
      url: "http://wrong:8080",
      username: "a",
      password: "b",
      fetch: async () => new Response("<html>Sonarr</html>"),
    });
    expect((await rejection(qbit.version(), QBittorrentError)).kind).toBe("invalid_response");
  });

  it("creates the category only when it is missing", async () => {
    const { fake, qbit } = client();
    await qbit.ensureCategory("mangarr");
    await qbit.ensureCategory("mangarr");
    expect([...fake.state.categories]).toEqual(["mangarr"]);
    expect(fake.state.requests.filter((r) => r.url.endsWith("createCategory"))).toHaveLength(1);
  });

  it("adds magnets and .torrent files in the category", async () => {
    const { fake, qbit } = client();
    await qbit.add({ kind: "magnet", uri: "magnet:?xt=urn:btih:abc" }, "mangarr");
    await qbit.add({ kind: "torrent", bytes: new Uint8Array([100, 101]) }, "mangarr");
    expect(fake.state.added).toEqual([
      { category: "mangarr", magnet: "magnet:?xt=urn:btih:abc", torrent: undefined },
      { category: "mangarr", magnet: undefined, torrent: new Uint8Array([100, 101]) },
    ]);
  });

  it("reports a torrent qBittorrent refuses", async () => {
    const { fake, qbit } = client();
    fake.state.addAnswer = "Fails.";
    expect((await rejection(qbit.add({ kind: "magnet", uri: "magnet:?xt=urn:btih:abc" }, "mangarr"), QBittorrentError)).message).toBe(
      "qBittorrent refused the torrent",
    );
  });

  it("reads qBittorrent 5.3's JSON answer to an add", async () => {
    const { fake, qbit } = client();
    fake.state.addAnswer = JSON.stringify({ added_torrent_ids: ["abc"], failure_count: 0, pending_count: 0, success_count: 1 });
    await qbit.add({ kind: "magnet", uri: "magnet:?xt=urn:btih:abc" }, "mangarr");
    fake.state.addAnswer = JSON.stringify({ added_torrent_ids: [], failure_count: 1, pending_count: 0, success_count: 0 });
    expect((await rejection(qbit.add({ kind: "magnet", uri: "magnet:?xt=urn:btih:abc" }, "mangarr"), QBittorrentError)).message).toBe(
      "qBittorrent refused the torrent",
    );
  });

  it("lists torrents by hash, lowercased", async () => {
    const { fake, qbit } = client();
    fake.state.torrents.push({ hash: "ABC", name: "x", category: "mangarr", state: "downloading", progress: 0.5, amount_left: 10 });
    expect(await qbit.torrents({ hashes: ["ABC"] })).toMatchObject([{ hash: "abc", amountLeft: 10, progress: 0.5 }]);
    expect(await qbit.torrents({ hashes: ["def"] })).toEqual([]);
  });
});

describe("qbittorrent.test", () => {
  afterEach(() => (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.());

  it("tests the form's values, falling back to the saved ones", async () => {
    const fake = fakeQBittorrent();
    spyOn(globalThis, "fetch").mockImplementation(fake.fetch as unknown as typeof fetch);
    const db = openDatabase(":memory:");
    const api = apiClient(db, { apiKey: ensureApiKey(db) });
    expect((await rejection(api.qbittorrent.test({}))).code).toBe("PRECONDITION_FAILED");
    setSetting(db, "qbittorrentUrl", fake.url);
    setSetting(db, "qbittorrentUsername", fake.username);
    setSetting(db, "qbittorrentPassword", fake.password);

    expect(await api.qbittorrent.test({})).toEqual({ version: "v5.1.2" });
    expect(await api.qbittorrent.test({ url: fake.url })).toEqual({ version: "v5.1.2" });
    const wrong = await rejection(api.qbittorrent.test({ url: fake.url, password: "nope" }));
    expect(wrong.code).toBe("BAD_GATEWAY");
  });

  it("never sends the saved password to another URL", async () => {
    const requests: Request[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(String(input), init));
      return new Response("Fails.", { status: 200 });
    }) as typeof fetch);
    const db = openDatabase(":memory:");
    const api = apiClient(db, { apiKey: ensureApiKey(db) });
    setSetting(db, "qbittorrentUrl", "http://qbittorrent:8080");
    setSetting(db, "qbittorrentUsername", "admin");
    setSetting(db, "qbittorrentPassword", "hunter2");

    await rejection(api.qbittorrent.test({ url: "http://attacker:8080" }));
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(await request.text()).not.toContain("hunter2");
  });
});
