// Prowlarr client: search, the indexer list, and a connection check (spec §6.1).
// Search only: mangarr never registers as a Prowlarr "Application".
//
// Every `downloadUrl` and `magnetUrl` Prowlarr returns is a link to its own download proxy,
// with Prowlarr's API key in the query string. Never log them.

import { z } from "zod";
import type { Db } from "../db/client";
import { errorMessage } from "../errors";
import { getSettings } from "../settings";
import { normalizeInfoHash, type TorrentSource } from "./torrent";
import { type Fetch, UpstreamError } from "./upstream";

export type { Fetch } from "./upstream";

export interface ProwlarrOptions {
  /** e.g. `http://prowlarr:9696`, or with a URL base such as `http://host/prowlarr`. */
  url: string;
  apiKey: string;
  fetch?: Fetch;
  /** For every call except search. */
  timeoutMs?: number;
  /** Search waits for every indexer to answer, so it gets longer. */
  searchTimeoutMs?: number;
}

export type ProwlarrErrorKind = "not_configured" | "unreachable" | "timeout" | "unauthorized" | "http" | "invalid_response";

export class ProwlarrError extends UpstreamError {
  declare readonly kind: ProwlarrErrorKind;

  constructor(kind: ProwlarrErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(kind, message, options);
    this.name = "ProwlarrError";
  }
}

export type Protocol = "torrent" | "usenet" | "unknown";

export interface ProwlarrRelease {
  guid: string;
  title: string;
  /** Bytes. 0 when the indexer didn't say. */
  size: number;
  indexerId: number;
  indexer: string;
  protocol: Protocol;
  /** Epoch milliseconds. */
  publishDate?: number;
  /** Prowlarr proxy link (holds the API key). */
  downloadUrl?: string;
  /** Prowlarr proxy link that redirects to the magnet (holds the API key). */
  magnetUrl?: string;
  /** v1 info-hash as lowercase hex, when the indexer gave a usable one. */
  infoHash?: string;
  seeders?: number;
  leechers?: number;
  /** The release's page on the indexer. */
  infoUrl?: string;
}

/** Larger than any manga .torrent; a bigger body is something else. */
const maxTorrentBytes = 10 * 1024 * 1024;
const maxRedirects = 5;

export interface ProwlarrCategory {
  id: number;
  name: string;
  subCategories: ProwlarrCategory[];
}

export interface ProwlarrIndexer {
  id: number;
  name: string;
  enabled: boolean;
  protocol: Protocol;
  privacy?: "public" | "semiPrivate" | "private";
  priority?: number;
  /** The definition's language, e.g. `en-US`. A hint only: languages are set per Language record. */
  language?: string;
  categories: ProwlarrCategory[];
}

export interface ProwlarrStatus {
  version: string;
}

export interface SearchParams {
  query: string;
  /** Must not be empty: Prowlarr would search every indexer. */
  indexerIds: readonly number[];
  /** Empty means all categories. */
  categories?: readonly number[];
  /** Results per indexer. Prowlarr's default applies when omitted. */
  limit?: number;
  signal?: AbortSignal;
}

// Prowlarr leaves null fields out of its JSON. `nullish` also accepts an explicit null.

const protocol = z.enum(["torrent", "usenet", "unknown"]).catch("unknown");

const releaseSchema = z.object({
  guid: z.string().min(1),
  title: z.string().min(1),
  size: z.number().nullish(),
  indexerId: z.number(),
  indexer: z.string().nullish(),
  protocol,
  publishDate: z.string().nullish(),
  downloadUrl: z.string().nullish(),
  magnetUrl: z.string().nullish(),
  infoHash: z.string().nullish(),
  seeders: z.number().nullish(),
  leechers: z.number().nullish(),
  infoUrl: z.string().nullish(),
});

const categorySchema = z.object({
  id: z.number(),
  name: z.string(),
  get subCategories() {
    return z.array(categorySchema).nullish();
  },
});

const indexerSchema = z.object({
  id: z.number(),
  name: z.string(),
  enable: z.boolean(),
  protocol,
  privacy: z.enum(["public", "semiPrivate", "private"]).optional().catch(undefined),
  priority: z.number().nullish(),
  language: z.string().nullish(),
  capabilities: z.object({ categories: z.array(categorySchema).nullish() }).nullish(),
});

const statusSchema = z.object({ appName: z.string(), version: z.string() });

function toRelease(raw: z.infer<typeof releaseSchema>): ProwlarrRelease {
  const published = raw.publishDate ? Date.parse(raw.publishDate) : Number.NaN;
  return {
    guid: raw.guid,
    title: raw.title,
    size: raw.size ?? 0,
    indexerId: raw.indexerId,
    indexer: raw.indexer ?? `Indexer ${raw.indexerId}`,
    protocol: raw.protocol,
    publishDate: Number.isNaN(published) ? undefined : published,
    downloadUrl: raw.downloadUrl || undefined,
    magnetUrl: raw.magnetUrl || undefined,
    infoHash: normalizeInfoHash(raw.infoHash),
    seeders: raw.seeders ?? undefined,
    leechers: raw.leechers ?? undefined,
    infoUrl: raw.infoUrl || undefined,
  };
}

function toCategory(raw: z.infer<typeof categorySchema>): ProwlarrCategory {
  return { id: raw.id, name: raw.name, subCategories: (raw.subCategories ?? []).map(toCategory) };
}

function toIndexer(raw: z.infer<typeof indexerSchema>): ProwlarrIndexer {
  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enable,
    protocol: raw.protocol,
    privacy: raw.privacy,
    priority: raw.priority ?? undefined,
    language: raw.language || undefined,
    categories: (raw.capabilities?.categories ?? []).map(toCategory),
  };
}

/** Prowlarr answers errors with `{ message }`, or a list of `{ errorMessage }` for validation errors. */
function errorDetail(body: string): string | undefined {
  try {
    const json: unknown = JSON.parse(body);
    if (Array.isArray(json)) {
      const messages = json.map((item) => (item as { errorMessage?: unknown })?.errorMessage).filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    } else if (typeof (json as { message?: unknown })?.message === "string") {
      return (json as { message: string }).message;
    }
  } catch {
    // Not JSON: fall back to the text.
  }
  const text = body.trim().slice(0, 200);
  return text || undefined;
}

const isTimeout = (error: unknown) => (error as { name?: unknown })?.name === "TimeoutError";

export function createProwlarrClient(options: ProwlarrOptions) {
  const baseUrl = options.url.trim().replace(/\/+$/, "");
  const fetchImpl: Fetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const searchTimeoutMs = options.searchTimeoutMs ?? 90_000;

  /** GET `/api/v1/<path>` and return the parsed JSON body. */
  async function get(path: string, query: URLSearchParams | undefined, timeout: number, signal?: AbortSignal) {
    const url = `${baseUrl}/api/v1/${path}${query?.size ? `?${query}` : ""}`;
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);

    // Errors name the base URL only: the API key travels in a header, never in the URL.
    const failed = (error: unknown): never => {
      // The caller cancelled: let their abort error through unchanged.
      if (signal?.aborted) throw error;
      if (isTimeout(error)) {
        throw new ProwlarrError("timeout", `Prowlarr at ${baseUrl} did not answer within ${timeout / 1000} s`, {
          cause: error,
        });
      }
      throw new ProwlarrError("unreachable", `Could not reach Prowlarr at ${baseUrl}: ${errorMessage(error)}`, { cause: error });
    };

    let response: Response;
    try {
      response = await fetchImpl(
        new Request(url, {
          headers: { "X-Api-Key": options.apiKey, Accept: "application/json" },
          signal: AbortSignal.any(signals),
        }),
      );
    } catch (error) {
      return failed(error);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      return failed(error);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProwlarrError("unauthorized", "Prowlarr rejected the API key", { status: response.status });
    }
    if (!response.ok) {
      const detail = errorDetail(body);
      throw new ProwlarrError(
        "http",
        `Prowlarr answered ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      // Typically a reverse proxy or another app's web page: the URL is wrong.
      throw new ProwlarrError("invalid_response", `${baseUrl} did not answer like Prowlarr (not JSON). Check the URL.`, {
        cause: error,
      });
    }
  }

  function parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new ProwlarrError("invalid_response", `Unexpected ${what} from Prowlarr: ${z.prettifyError(result.error)}`, {
        cause: result.error,
      });
    }
    return result.data;
  }

  return {
    /** For the connection test. Fails if the URL points at another *arr app. */
    async status(signal?: AbortSignal): Promise<ProwlarrStatus> {
      const status = parse(statusSchema, await get("system/status", undefined, timeoutMs, signal), "status");
      if (status.appName !== "Prowlarr") {
        throw new ProwlarrError("invalid_response", `${baseUrl} is ${status.appName}, not Prowlarr`);
      }
      return { version: status.version };
    },

    /** Every indexer configured in Prowlarr, for the Language settings picker. */
    async indexers(signal?: AbortSignal): Promise<ProwlarrIndexer[]> {
      const list = parse(z.array(indexerSchema), await get("indexer", undefined, timeoutMs, signal), "indexer list");
      return list.map(toIndexer);
    },

    /**
     * One search across the given indexers. Results that don't have the expected shape are skipped.
     * Prowlarr answers most failures (including every indexer failing) with an empty list rather than an error.
     */
    async search({ query, indexerIds, categories = [], limit, signal }: SearchParams): Promise<ProwlarrRelease[]> {
      if (indexerIds.length === 0) {
        throw new Error("Prowlarr search needs at least one indexer ID; with none, Prowlarr searches every indexer");
      }
      const params = new URLSearchParams({ query, type: "search" });
      // ASP.NET binds repeated keys to a list.
      for (const id of indexerIds) params.append("indexerIds", String(id));
      for (const id of categories) params.append("categories", String(id));
      if (limit !== undefined) params.set("limit", String(limit));

      const items = parse(z.array(z.unknown()), await get("search", params, searchTimeoutMs, signal), "search results");
      const releases: ProwlarrRelease[] = [];
      let skipped = 0;
      for (const item of items) {
        const result = releaseSchema.safeParse(item);
        if (result.success) releases.push(toRelease(result.data));
        else skipped++;
      }
      if (skipped > 0) console.warn(`prowlarr: skipped ${skipped} search result(s) with an unexpected shape`);
      return releases;
    },

    /**
     * Follows a release's `downloadUrl` or `magnetUrl` (a Prowlarr proxy link) to a magnet link or a
     * .torrent file. Redirects are followed by hand, so a redirect to `magnet:` can be read.
     * Errors never name the link: it holds Prowlarr's API key.
     */
    async download(link: string, signal?: AbortSignal): Promise<TorrentSource> {
      if (link.startsWith("magnet:")) return { kind: "magnet", uri: link };
      let url = link;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const signals = [AbortSignal.timeout(timeoutMs * 2)];
        if (signal) signals.push(signal);
        let response: Response;
        try {
          response = await fetchImpl(new Request(url, { redirect: "manual", signal: AbortSignal.any(signals) }));
        } catch (error) {
          if (signal?.aborted) throw error;
          if (isTimeout(error)) throw new ProwlarrError("timeout", "Prowlarr did not send the torrent in time", { cause: error });
          throw new ProwlarrError("unreachable", `Could not fetch the torrent through Prowlarr: ${errorMessage(error)}`, { cause: error });
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new ProwlarrError("invalid_response", "Prowlarr redirected the download nowhere");
          if (location.startsWith("magnet:")) return { kind: "magnet", uri: location };
          url = new URL(location, url).href;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          throw new ProwlarrError("unauthorized", "Prowlarr refused the download link", { status: response.status });
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!response.ok) {
          const detail = errorDetail(new TextDecoder().decode(bytes.subarray(0, 2000)));
          throw new ProwlarrError("http", `Prowlarr could not get the torrent (${response.status})${detail ? `: ${detail}` : ""}`, {
            status: response.status,
          });
        }
        const text = new TextDecoder().decode(bytes.subarray(0, 7));
        // Some indexers answer with the magnet link as text.
        if (text === "magnet:") return { kind: "magnet", uri: new TextDecoder().decode(bytes).trim() };
        if (bytes.length > maxTorrentBytes || bytes[0] !== 0x64) {
          throw new ProwlarrError("invalid_response", "The indexer sent something that is not a .torrent file");
        }
        return { kind: "torrent", bytes };
      }
      throw new ProwlarrError("invalid_response", `The download link redirected more than ${maxRedirects} times`);
    },
  };
}

export type ProwlarrClient = ReturnType<typeof createProwlarrClient>;

/** A client using the saved Prowlarr URL and API key. */
export function prowlarrFromSettings(db: Db, fetch?: Fetch): ProwlarrClient {
  const { prowlarrUrl, prowlarrApiKey } = getSettings(db);
  if (!prowlarrUrl || !prowlarrApiKey) {
    throw new ProwlarrError("not_configured", "Set the Prowlarr URL and API key in Settings first");
  }
  return createProwlarrClient({ url: prowlarrUrl, apiKey: prowlarrApiKey, fetch });
}
