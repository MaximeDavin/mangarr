// qBittorrent client, Web API v2 (spec §6.2): login, categories, adding torrents, and looking them up.
// mangarr never deletes or pauses torrents.

import { z } from "zod";
import type { Db } from "../db/client";
import { errorMessage } from "../errors";
import { getSettings } from "../settings";
import type { TorrentSource } from "./torrent";
import { type Fetch, UpstreamError } from "./upstream";

export interface QBittorrentOptions {
  /** e.g. `http://qbittorrent:8080`. */
  url: string;
  username: string;
  password: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export type QBittorrentErrorKind = "not_configured" | "unreachable" | "timeout" | "unauthorized" | "http" | "invalid_response";

export class QBittorrentError extends UpstreamError {
  declare readonly kind: QBittorrentErrorKind;

  constructor(kind: QBittorrentErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(kind, message, options);
    this.name = "QBittorrentError";
  }
}

export interface QBittorrentTorrent {
  hash: string;
  name: string;
  category: string;
  /** e.g. `downloading`, `stalledDL`, `metaDL`, `uploading`, `stoppedUP`, `checkingUP`, `moving`, `error`. */
  state: string;
  /** 0 to 1. */
  progress: number;
  /** Bytes still to download. */
  amountLeft: number;
  /** The folder the torrent's files are relative to. */
  savePath: string;
  /** Seconds; left out when qBittorrent doesn't know. */
  eta?: number;
  /** Bytes per second. */
  downloadSpeed: number;
}

export interface QBittorrentFile {
  /** Relative to the torrent's save path, with "/" separators (multi-file torrents start with their folder). */
  name: string;
  size: number;
  /** 0 to 1. */
  progress: number;
  /** 0 means "do not download". */
  priority: number;
}

/** qBittorrent's "unknown" ETA. */
const unknownEta = 8_640_000;

const torrentSchema = z
  .object({
    hash: z.string(),
    name: z.string(),
    category: z.string().catch(""),
    state: z.string(),
    progress: z.number(),
    amount_left: z.number(),
    save_path: z.string().catch(""),
    eta: z.number().catch(unknownEta),
    dlspeed: z.number().catch(0),
  })
  .transform(
    (t): QBittorrentTorrent => ({
      hash: t.hash.toLowerCase(),
      name: t.name,
      category: t.category,
      state: t.state,
      progress: t.progress,
      amountLeft: t.amount_left,
      savePath: t.save_path,
      eta: t.eta >= 0 && t.eta < unknownEta ? t.eta : undefined,
      downloadSpeed: t.dlspeed,
    }),
  );

const fileSchema = z.object({
  name: z.string(),
  size: z.number(),
  progress: z.number(),
  priority: z.number().catch(1),
});

/** Category name → its settings. Anything else reads as "no categories", so the category gets created. */
const categoriesSchema = z.record(z.string(), z.unknown()).catch({});

/** States in which qBittorrent may still change the files. */
const busyStates = /^(checking|metaDL|forcedMetaDL|moving|missingFiles|error|allocating|unknown)/;

/**
 * Downloaded and settled (spec §6.2): nothing left to download and not checking. A magnet still
 * fetching its metadata also has nothing left, so progress must be 1 too.
 */
export const isComplete = (torrent: QBittorrentTorrent) =>
  torrent.amountLeft === 0 && torrent.progress >= 1 && !busyStates.test(torrent.state);

const isTimeout = (error: unknown) => (error as { name?: unknown })?.name === "TimeoutError";

interface CallOptions {
  method?: "GET" | "POST";
  /** Reusable as is when a call is sent again after logging in. */
  body?: URLSearchParams | FormData;
  query?: URLSearchParams;
}

export function createQBittorrentClient(options: QBittorrentOptions) {
  const baseUrl = options.url.trim().replace(/\/+$/, "");
  const fetchImpl: Fetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 15_000;
  /** The session cookie(s) from the last login. The name changed across versions (SID, QBT_SID_<port>). */
  let cookie: string | undefined;
  let loggedIn = false;

  async function send(path: string, { method = "GET", body, query }: CallOptions = {}) {
    const url = `${baseUrl}/api/v2/${path}${query?.size ? `?${query}` : ""}`;
    const headers = new Headers({ Referer: baseUrl });
    if (cookie) headers.set("Cookie", cookie);
    try {
      return await fetchImpl(new Request(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) }));
    } catch (error) {
      if (isTimeout(error)) {
        throw new QBittorrentError("timeout", `qBittorrent at ${baseUrl} did not answer within ${timeoutMs / 1000} s`, { cause: error });
      }
      throw new QBittorrentError("unreachable", `Could not reach qBittorrent at ${baseUrl}: ${errorMessage(error)}`, { cause: error });
    }
  }

  async function login(): Promise<void> {
    const body = new URLSearchParams({ username: options.username, password: options.password });
    cookie = undefined;
    loggedIn = false;
    const response = await send("auth/login", { method: "POST", body });
    const text = (await response.text()).trim();
    if (response.status === 403) {
      throw new QBittorrentError("unauthorized", "qBittorrent has banned this IP after too many failed logins", { status: 403 });
    }
    if (text === "Fails.") {
      throw new QBittorrentError("unauthorized", "qBittorrent rejected the username or password", { status: response.status });
    }
    // Newer versions answer bad credentials with 401, but so do its CSRF and Host header checks.
    if (response.status === 401) {
      throw new QBittorrentError(
        "unauthorized",
        "qBittorrent refused the login (401): check the username and password, then the Web UI's Host header validation and CSRF protection options",
        { status: 401 },
      );
    }
    if (!response.ok) throw new QBittorrentError("http", `qBittorrent answered ${response.status} to the login`, { status: response.status });
    // No cookie happens when qBittorrent skips authentication for this client's subnet.
    const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]!.trim()).filter(Boolean);
    cookie = cookies.length > 0 ? cookies.join("; ") : undefined;
    loggedIn = true;
  }

  /** A call that logs in first, and again once when the session has expired (403). */
  async function call(path: string, init: CallOptions = {}) {
    if (!loggedIn) await login();
    let response = await send(path, init);
    if (response.status === 403) {
      await login();
      response = await send(path, init);
    }
    if (response.status === 403) throw new QBittorrentError("unauthorized", "qBittorrent refused the session after logging in", { status: 403 });
    return response;
  }

  async function text(response: Response, what: string): Promise<string> {
    const body = (await response.text()).trim();
    if (!response.ok) {
      throw new QBittorrentError("http", `qBittorrent answered ${response.status} to ${what}${body ? `: ${body.slice(0, 200)}` : ""}`, {
        status: response.status,
      });
    }
    return body;
  }

  /** The JSON answer, checked against `schema`. */
  async function read<T>(response: Response, what: string, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
      body = JSON.parse(await text(response, what));
    } catch (error) {
      if (error instanceof QBittorrentError) throw error;
      throw new QBittorrentError("invalid_response", `${baseUrl} did not answer like qBittorrent (not JSON). Check the URL.`, { cause: error });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new QBittorrentError("invalid_response", `Unexpected answer from qBittorrent to ${what}`, { cause: parsed.error });
    return parsed.data;
  }

  return {
    /** For the connection test: logs in and reads the version, e.g. `v5.1.2`. */
    async version(): Promise<string> {
      const version = await text(await call("app/version"), "the version request");
      if (!/^v?\d+\.\d+/.test(version)) {
        throw new QBittorrentError("invalid_response", `${baseUrl} did not answer like qBittorrent. Check the URL.`);
      }
      return version;
    },

    /** Creates the category when it doesn't exist. */
    async ensureCategory(category: string): Promise<void> {
      const existing = await read(await call("torrents/categories"), "the category list", categoriesSchema);
      if (category in existing) return;
      const response = await call("torrents/createCategory", { method: "POST", body: new URLSearchParams({ category, savePath: "" }) });
      // 409: created meanwhile.
      if (response.status !== 409) await text(response, `creating the category "${category}"`);
    },

    /** Torrents by info-hash (any category). */
    async torrents(filter: { hashes?: readonly string[]; category?: string } = {}): Promise<QBittorrentTorrent[]> {
      const query = new URLSearchParams();
      if (filter.hashes) query.set("hashes", filter.hashes.join("|"));
      if (filter.category !== undefined) query.set("category", filter.category);
      return read(await call("torrents/info", { query }), "the torrent list", z.array(torrentSchema));
    },

    /** The files in a torrent. Empty while a magnet's metadata is still being fetched. */
    async files(hash: string): Promise<QBittorrentFile[]> {
      return read(await call("torrents/files", { query: new URLSearchParams({ hash }) }), "the file list", z.array(fileSchema));
    },

    /** Adds a torrent in the category. qBittorrent answers before it has fetched a magnet's metadata. */
    async add(source: TorrentSource, category: string): Promise<void> {
      const form = new FormData();
      if (source.kind === "magnet") form.append("urls", source.uri);
      else form.append("torrents", new Blob([source.bytes], { type: "application/x-bittorrent" }), "release.torrent");
      form.append("category", category);
      const response = await call("torrents/add", { method: "POST", body: form });
      // 5.3 answers 409 when it already has the torrent.
      if (response.status === 409) throw new QBittorrentError("http", "qBittorrent already has this torrent", { status: 409 });
      const body = await text(response, "adding the torrent");
      // Before 5.3: "Ok." or "Fails.". From 5.3: counts as JSON, still with status 200 on failure.
      if (body === "Fails.") throw new QBittorrentError("http", "qBittorrent refused the torrent");
      if (body.startsWith("{")) {
        let counts: { success_count?: unknown; pending_count?: unknown; failure_count?: unknown } = {};
        try {
          counts = JSON.parse(body) as typeof counts;
        } catch {
          // Not JSON after all: nothing to read.
        }
        if (Number(counts.failure_count) > 0 && !(Number(counts.success_count) > 0) && !(Number(counts.pending_count) > 0)) {
          throw new QBittorrentError("http", "qBittorrent refused the torrent");
        }
      }
    },
  };
}

export type QBittorrentClient = ReturnType<typeof createQBittorrentClient>;

/** One client per database while the settings stay the same, so its session is reused. */
const clients = new WeakMap<Db, { key: string; client: QBittorrentClient }>();

/** A client using the saved qBittorrent URL and credentials, with the saved category. */
export function qbittorrentFromSettings(db: Db): { client: QBittorrentClient; category: string } {
  const { qbittorrentUrl, qbittorrentUsername, qbittorrentPassword, qbittorrentCategory } = getSettings(db);
  if (!qbittorrentUrl) throw new QBittorrentError("not_configured", "Set the qBittorrent URL in Settings first");
  const options = { url: qbittorrentUrl, username: qbittorrentUsername, password: qbittorrentPassword };
  const key = JSON.stringify(options);
  let cached = clients.get(db);
  if (cached?.key !== key) {
    cached = { key, client: createQBittorrentClient(options) };
    clients.set(db, cached);
  }
  return { client: cached.client, category: qbittorrentCategory };
}
