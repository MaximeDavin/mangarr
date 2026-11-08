// MangaBaka client (spec §6.4): series search, the series record, and collections (volume counts).
// Public REST API, no key. The endpoints are described in https://mangabaka.org/api.json.
//
// Rate limits are per IP: search 30/min, everything else 180/min. On a 429 the client waits for
// `Retry-After` and tries once more when the wait is short; otherwise it fails with `rate_limited`.

import { z } from "zod";
import type { ExternalIds } from "../db/schema";
import { errorMessage } from "../errors";
import { type Fetch, UpstreamError } from "./upstream";

export const mangabakaUrl = "https://api.mangabaka.org";

export interface MangaBakaOptions {
  /** Defaults to the live API. */
  url?: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The longest `Retry-After` the client waits out before retrying once. */
const maxRetryWaitMs = 10_000;

export type MangaBakaErrorKind = "unreachable" | "timeout" | "rate_limited" | "not_found" | "http" | "invalid_response";

export class MangaBakaError extends UpstreamError {
  declare readonly kind: MangaBakaErrorKind;

  constructor(
    kind: MangaBakaErrorKind,
    message: string,
    options: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(kind, message, options);
    this.name = "MangaBakaError";
  }
}

export interface MangaBakaTitle {
  title: string;
  /** e.g. `en`, `fr`, `ja`, `ja-Latn` (romanized), `pt-br`. */
  language: string;
  isPrimary: boolean;
}

export interface MangaBakaPublisher {
  name: string;
  language?: string;
}

export interface MangaBakaSeries {
  id: number;
  /** MangaBaka's main title, usually English or romanized. */
  title: string;
  nativeTitle?: string;
  romanizedTitle?: string;
  /** Every title, with its language. */
  titles: MangaBakaTitle[];
  /** e.g. `manga`, `manhwa`, `manhua`, `novel`. */
  type: string;
  /** e.g. `releasing`, `completed`, `hiatus`, `cancelled`. */
  status: string;
  year?: number;
  /** e.g. `ja`. */
  originalLanguage?: string;
  authors: string[];
  artists: string[];
  /** 350 px wide. */
  coverUrl?: string;
  /** 150 px wide, for search results. */
  thumbnailUrl?: string;
  /** Volumes in the original language. */
  finalVolume?: number;
  publishers: MangaBakaPublisher[];
  externalIds: ExternalIds;
}

/** A published run of a series in one language and edition, with its volume count. */
export interface MangaBakaCollection {
  id: string;
  title: string;
  /** e.g. `en`, `fr`. */
  language: string;
  /** e.g. `Standard Edition`, `Omnibus Edition`. */
  edition?: string;
  /** `volume` for tankōbon runs. */
  type: string;
  /** e.g. `paperback`, `digital`. */
  medium?: string;
  publisher?: string;
  /** Main volumes (extras and others not counted). */
  volumeCount: number;
}

// MangaBaka sends null for missing values. `nullish` also accepts a missing key.

const titleSchema = z.object({
  title: z.string().min(1),
  language: z.string(),
  is_primary: z.boolean().nullish(),
});

const coverSize = z.object({ x1: z.string().nullish() }).nullish();

const seriesSchema = z.object({
  id: z.number(),
  state: z.string().nullish(),
  merged_with: z.number().nullish(),
  title: z.string(),
  native_title: z.string().nullish(),
  romanized_title: z.string().nullish(),
  titles: z.array(titleSchema).nullish(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  year: z.number().nullish(),
  original_language: z.string().nullish(),
  authors: z.array(z.string()).nullish(),
  artists: z.array(z.string()).nullish(),
  cover: z
    .object({ raw: z.object({ url: z.string().nullish() }).nullish(), x150: coverSize, x350: coverSize })
    .nullish(),
  final_volume: z.string().nullish(),
  publishers: z.array(z.object({ name: z.string(), language: z.string().nullish() })).nullish(),
  source: z
    .object({
      anilist: z.object({ id: z.number().nullish() }).nullish(),
      my_anime_list: z.object({ id: z.number().nullish() }).nullish(),
      manga_updates: z.object({ id: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

const collectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  language: z.object({ iso: z.string() }),
  publisher: z.object({ name: z.string() }).nullish(),
  edition: z.object({ name: z.string() }).nullish(),
  type: z.string(),
  medium: z.string().nullish(),
  count_main: z.number().nullish(),
});

const envelope = <T extends z.ZodType>(data: T) => z.object({ data });
const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), pagination: z.object({ next: z.string().nullish() }).nullish() });

/** Fields of the series record mangarr never reads, dropped before caching. Together they are most of its size. */
const bulkyFields = ["tags_v2", "links_v2", "relationships_v2"];

/** The series record as cached in `series.metadataJson`, without the bulky fields. */
export function slimRecord(record: unknown): unknown {
  if (!record || typeof record !== "object") return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !bulkyFields.includes(key)));
}

function toVolumeCount(value: string | null | undefined): number | undefined {
  const n = value ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function toSeries(raw: z.infer<typeof seriesSchema>): MangaBakaSeries {
  const externalIds: ExternalIds = {};
  if (raw.source?.anilist?.id) externalIds.anilist = raw.source.anilist.id;
  if (raw.source?.my_anime_list?.id) externalIds.mal = raw.source.my_anime_list.id;
  if (raw.source?.manga_updates?.id) externalIds.mangaupdates = raw.source.manga_updates.id;
  return {
    id: raw.id,
    title: raw.title,
    nativeTitle: raw.native_title || undefined,
    romanizedTitle: raw.romanized_title || undefined,
    titles: (raw.titles ?? []).map((t) => ({
      title: t.title,
      language: t.language,
      isPrimary: t.is_primary ?? false,
    })),
    type: raw.type ?? "unknown",
    status: raw.status ?? "unknown",
    year: raw.year ?? undefined,
    originalLanguage: raw.original_language || undefined,
    authors: raw.authors ?? [],
    artists: raw.artists ?? [],
    coverUrl: raw.cover?.x350?.x1 || raw.cover?.raw?.url || undefined,
    thumbnailUrl: raw.cover?.x150?.x1 || raw.cover?.raw?.url || undefined,
    finalVolume: toVolumeCount(raw.final_volume),
    publishers: (raw.publishers ?? []).map((p) => ({ name: p.name, language: p.language || undefined })),
    externalIds,
  };
}

function toCollection(raw: z.infer<typeof collectionSchema>): MangaBakaCollection {
  return {
    id: raw.id,
    title: raw.title,
    language: raw.language.iso,
    edition: raw.edition?.name,
    type: raw.type,
    medium: raw.medium || undefined,
    publisher: raw.publisher?.name,
    volumeCount: raw.count_main ?? 0,
  };
}

/** `Retry-After` as seconds or an HTTP date. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

const isTimeout = (error: unknown) => (error as { name?: unknown })?.name === "TimeoutError";
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMangaBakaClient(options: MangaBakaOptions = {}) {
  const baseUrl = (options.url ?? mangabakaUrl).trim().replace(/\/+$/, "");
  const fetchImpl: Fetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;

  /** GET `<path>` and return the parsed JSON body. */
  async function get(path: string, query?: URLSearchParams, signal?: AbortSignal, retried = false): Promise<unknown> {
    const url = `${baseUrl}${path}${query?.size ? `?${query}` : ""}`;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);

    const failed = (error: unknown): never => {
      if (signal?.aborted) throw error;
      if (isTimeout(error)) {
        throw new MangaBakaError("timeout", `MangaBaka did not answer within ${timeoutMs / 1000} s`, { cause: error });
      }
      throw new MangaBakaError("unreachable", `Could not reach MangaBaka: ${errorMessage(error)}`, { cause: error });
    };

    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(
        new Request(url, {
          headers: { Accept: "application/json", "User-Agent": "mangarr" },
          signal: AbortSignal.any(signals),
        }),
      );
      body = await response.text();
    } catch (error) {
      return failed(error);
    }

    if (response.status === 429) {
      const wait = retryAfterSeconds(response.headers.get("retry-after"));
      if (!retried && wait !== undefined && wait * 1000 <= maxRetryWaitMs) {
        await sleep(wait * 1000);
        return get(path, query, signal, true);
      }
      throw new MangaBakaError(
        "rate_limited",
        `MangaBaka is rate limiting mangarr${wait !== undefined ? `; try again in ${wait} s` : ""}`,
        { status: 429, retryAfterSeconds: wait },
      );
    }
    if (response.status === 404) {
      throw new MangaBakaError("not_found", "MangaBaka has no such series", { status: 404 });
    }
    if (!response.ok) {
      const detail = body.trim().slice(0, 200);
      throw new MangaBakaError("http", `MangaBaka answered ${response.status}${detail ? `: ${detail}` : ""}`, {
        status: response.status,
      });
    }
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new MangaBakaError("invalid_response", "MangaBaka's answer was not JSON", { cause: error });
    }
  }

  function parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new MangaBakaError("invalid_response", `Unexpected ${what} from MangaBaka: ${z.prettifyError(result.error)}`, {
        cause: result.error,
      });
    }
    return result.data;
  }

  /** The record, following one merge. `record` is the raw JSON, for caching. */
  async function fetchSeries(
    id: number,
    signal: AbortSignal | undefined,
    followMerge: boolean,
  ): Promise<{ series: MangaBakaSeries; record: unknown }> {
    const json = await get(`/v1/series/${id}`, undefined, signal);
    const { data } = parse(envelope(z.unknown()), json, "series");
    const raw = parse(seriesSchema, data, "series");
    if (raw.state === "merged" && raw.merged_with && followMerge) return fetchSeries(raw.merged_with, signal, false);
    if (raw.state === "deleted" || raw.state === "merged") {
      throw new MangaBakaError("not_found", `MangaBaka series ${id} was ${raw.state}`);
    }
    return { series: toSeries(raw), record: slimRecord(data) };
  }

  return {
    /** Series search for the add-series flow. Novels are left out: mangarr handles manga volumes only. */
    async search(query: string, { limit = 20, signal }: { limit?: number; signal?: AbortSignal } = {}) {
      const params = new URLSearchParams([
        ["q", query],
        ["limit", String(limit)],
        ["type_not", "novel"],
      ]);
      const json = await get("/v1/series/search", params, signal);
      const { data } = parse(page(z.unknown()), json, "search results");
      // A result we can't read is skipped rather than failing the whole search.
      return data.flatMap((item) => {
        const result = seriesSchema.safeParse(item);
        return result.success ? [toSeries(result.data)] : [];
      });
    },

    /** One series. A merged series answers with the series it was merged into (check `series.id`). */
    getSeries(id: number, signal?: AbortSignal) {
      return fetchSeries(id, signal, true);
    },

    /** Every collection of a series (beta endpoint), across pages. */
    async collections(id: number, signal?: AbortSignal): Promise<MangaBakaCollection[]> {
      const all: MangaBakaCollection[] = [];
      // Page size is capped at 50; a series rarely has more than a handful of collections.
      for (let pageNumber = 1; pageNumber <= 10; pageNumber++) {
        const params = new URLSearchParams({ page: String(pageNumber), limit: "50" });
        const json = await get(`/v1/series/${id}/collections`, params, signal);
        const { data, pagination } = parse(page(collectionSchema), json, "collections");
        all.push(...data.map(toCollection));
        if (!pagination?.next) break;
      }
      return all;
    },
  };
}

export type MangaBakaClient = ReturnType<typeof createMangaBakaClient>;
