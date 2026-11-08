import { describe, expect, it } from "bun:test";
import { createMangaBakaClient, MangaBakaError } from "../src/integrations/mangabaka";
import type { Fetch } from "../src/integrations/upstream";
import { draftAuthors, draftPublisher, draftTerms, draftVolumeCount, sameLanguage } from "../src/library/prefill";
import { rejection } from "./helpers";
import { recorded, replayedMangaBaka } from "./mangabaka-replay";

const failure = (call: Promise<unknown>) => rejection(call, MangaBakaError);

describe("against recorded calls", () => {
  it("searches without novels and reads every result", async () => {
    const { mangabaka, fetch } = replayedMangaBaka();
    const results = await mangabaka.search("berserk", { limit: 5 });
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.type !== "novel")).toBe(true);
    expect(results[0]).toMatchObject({ id: recorded.berserk, title: "BERSERK", type: "manga" });
    expect(new URL(fetch.requests[0]!.url).searchParams.getAll("type_not")).toEqual(["novel"]);
  });

  it("reads a series record", async () => {
    const { mangabaka } = replayedMangaBaka();
    const { series, record } = await mangabaka.getSeries(recorded.berserk);
    expect(series).toMatchObject({
      id: recorded.berserk,
      title: "BERSERK",
      nativeTitle: "ベルセルク",
      originalLanguage: "ja",
      authors: ["MIURA Kentaro", "MORI Kouji"],
      externalIds: { anilist: 30002, mal: 2, mangaupdates: "njeqwry" },
    });
    expect(series.finalVolume).toBeGreaterThan(40);
    expect(series.coverUrl).toStartWith("https://");
    expect(series.titles.length).toBeGreaterThan(10);
    // Cached without the bulky fields.
    expect(record).toMatchObject({ id: recorded.berserk });
    expect(record).not.toHaveProperty("tags_v2");
  });

  it("reads collections, and an empty list", async () => {
    const { mangabaka } = replayedMangaBaka();
    expect(await mangabaka.collections(recorded.berserk)).toEqual([]);
    const blueLock = await mangabaka.collections(recorded.blueLock);
    expect(blueLock.length).toBeGreaterThan(1);
    expect(blueLock.find((c) => c.edition === "Standard Edition" && c.medium === "digital")).toMatchObject({
      language: "en",
      type: "volume",
    });
  });

  it("reports a series MangaBaka doesn't have", async () => {
    const { mangabaka } = replayedMangaBaka();
    expect((await failure(mangabaka.getSeries(recorded.missing))).kind).toBe("not_found");
  });
});

describe("edge cases", () => {
  const client = (respond: (request: Request) => Response, sleep = async (_ms: number) => {}) => {
    const requests: Request[] = [];
    const fetch: Fetch = async (request) => {
      requests.push(request);
      return respond(request);
    };
    return { requests, mangabaka: createMangaBakaClient({ fetch, sleep, timeoutMs: 50 }) };
  };
  const record = (id: number, extra: object = {}) => ({ id, title: `Series ${id}`, ...extra });

  it("waits out a short Retry-After and tries once more", async () => {
    const waits: number[] = [];
    let calls = 0;
    const { mangabaka } = client(
      () =>
        ++calls === 1
          ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
          : Response.json({ data: [record(1)] }),
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(await mangabaka.search("x")).toHaveLength(1);
    expect(waits).toEqual([2000]);
  });

  it("fails with rate_limited when the wait is too long or the retry is limited too", async () => {
    const long = client(() => new Response("", { status: 429, headers: { "retry-after": "60" } }));
    const error = await failure(long.mangabaka.search("x"));
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 60 });
    expect(long.requests).toHaveLength(1);

    const again = client(() => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    expect((await failure(again.mangabaka.search("x"))).kind).toBe("rate_limited");
    expect(again.requests).toHaveLength(2);
  });

  it("follows a merged series once", async () => {
    const { mangabaka, requests } = client((request) =>
      request.url.endsWith("/v1/series/1")
        ? Response.json({ data: record(1, { state: "merged", merged_with: 2 }) })
        : Response.json({ data: record(2, { state: "active" }) }),
    );
    expect((await mangabaka.getSeries(1)).series.id).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("treats a deleted series as not found", async () => {
    const { mangabaka } = client(() => Response.json({ data: record(1, { state: "deleted" }) }));
    expect((await failure(mangabaka.getSeries(1))).kind).toBe("not_found");
  });

  it("reads every page of collections", async () => {
    const collection = (id: string) => ({ id, title: "T", language: { iso: "en" }, type: "volume", count_main: 3 });
    const { mangabaka } = client((request) =>
      new URL(request.url).searchParams.get("page") === "1"
        ? Response.json({ data: [collection("a")], pagination: { next: "page 2" } })
        : Response.json({ data: [collection("b")], pagination: { next: null } }),
    );
    expect((await mangabaka.collections(1)).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("reports server errors, bad JSON and a wrong shape", async () => {
    expect((await failure(client(() => new Response("oops", { status: 503 })).mangabaka.search("x"))).kind).toBe("http");
    expect((await failure(client(() => new Response("<html>")).mangabaka.search("x"))).kind).toBe("invalid_response");
    expect((await failure(client(() => Response.json({ nope: 1 })).mangabaka.getSeries(1))).kind).toBe(
      "invalid_response",
    );
  });

  it("skips a search result it can't read", async () => {
    const { mangabaka } = client(() => Response.json({ data: [record(1), { id: "bad" }] }));
    expect((await mangabaka.search("x")).map((s) => s.id)).toEqual([1]);
  });

  it("reports a network failure", async () => {
    const { mangabaka } = client(() => {
      throw new TypeError("connection refused");
    });
    expect((await failure(mangabaka.search("x"))).kind).toBe("unreachable");
  });
});

describe("prefill", () => {
  it("matches language tags", () => {
    expect(sameLanguage("fr", "fr")).toBe(true);
    expect(sameLanguage("pt-br", "pt")).toBe(true);
    expect(sameLanguage("zh-Hant", "zh")).toBe(true);
    expect(sameLanguage("pt", "pt-br")).toBe(false);
    expect(sameLanguage("fil", "fi")).toBe(false);
  });

  it("drafts search terms and aliases for English and French", async () => {
    const { mangabaka } = replayedMangaBaka();
    const { series } = await mangabaka.getSeries(recorded.blueLock);

    expect(draftTerms(series, "en")).toEqual({
      // "BLUELOCK" (romanized) reads the same as "Blue Lock" for titleMatch(), so it isn't repeated.
      searchTerms: ["Blue Lock", "ブルーロック"],
      aliases: expect.arrayContaining(["Buruu Rokku", "Mavi Kilit"]),
    });
    const aliases = draftTerms(series, "en").aliases;
    expect(aliases).not.toContain("Blue Lock");
    // Non-Latin titles from other languages never show up in release names.
    expect(aliases.some((a) => /\p{Script=Cyrillic}|\p{Script=Han}/u.test(a))).toBe(false);

    // MangaBaka has a French title (the same as the English one).
    expect(draftTerms(series, "fr").searchTerms[0]).toBe("Blue Lock");
  });

  it("only queries primary titles; the other series-language titles become aliases", () => {
    const series = {
      id: 1,
      title: "Frieren: Beyond Journey's End",
      originalLanguage: "ja",
      titles: [
        { title: "Frieren: Beyond Journey's End", language: "en", isPrimary: true },
        { title: "Frieren", language: "en", isPrimary: false },
        { title: "Sousou no Frieren", language: "ja-Latn", isPrimary: true },
        { title: "葬送のフリーレン", language: "ja", isPrimary: true },
        { title: "Frieren: Nach dem Ende der Reise", language: "de", isPrimary: true },
      ],
      type: "manga", status: "hiatus", authors: [], artists: [], publishers: [], externalIds: {},
    };
    expect(draftTerms(series, "en")).toEqual({
      searchTerms: ["Frieren: Beyond Journey's End", "Sousou no Frieren", "葬送のフリーレン"],
      aliases: ["Frieren", "Frieren: Nach dem Ende der Reise"],
    });
  });

  it("falls back to the main title for a language MangaBaka has no title in", async () => {
    const { mangabaka } = replayedMangaBaka();
    const { series } = await mangabaka.getSeries(recorded.blueLock);
    expect(draftTerms(series, "xx").searchTerms).toEqual(["Blue Lock", "ブルーロック"]);
  });

  it("drafts authors, publishers and the volume count", async () => {
    const { mangabaka } = replayedMangaBaka();
    const { series } = await mangabaka.getSeries(recorded.blueLock);
    expect(draftAuthors(series)).toEqual(["Muneyuki Kaneshiro", "Yuusuke Nomura"]);
    expect(draftPublisher(series, "fr")).toBe("Pika Édition");
    expect(draftPublisher(series, "de")).toBeUndefined();

    const collections = await mangabaka.collections(recorded.blueLock);
    const en = draftVolumeCount(series, collections, "en");
    expect(en.from).toBe("collection");
    // The Standard Edition's largest count (digital runs ahead of print), not an omnibus or box set.
    const standard = collections.filter((c) => c.edition === "Standard Edition").map((c) => c.volumeCount);
    expect(en.volumeCount).toBe(Math.max(...standard));
    expect(en.options.length).toBeGreaterThan(1);

    expect(draftVolumeCount(series, collections, "fr")).toMatchObject({
      volumeCount: series.finalVolume,
      from: "final_volume",
      options: [],
    });
  });

  it("has no volume count when MangaBaka has none", () => {
    const series = {
      id: 1, title: "T", titles: [], type: "manga", status: "releasing", authors: [], artists: [], publishers: [], externalIds: {},
    };
    expect(draftVolumeCount(series, [], "en")).toEqual({ volumeCount: null, from: null, options: [] });
  });
});
