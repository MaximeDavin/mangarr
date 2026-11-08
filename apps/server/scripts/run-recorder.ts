// Records every Prowlarr and qBittorrent call of a real run (scripts/try-run.ts --record), with
// secrets scrubbed, for test/run.test.ts to replay.
//
// Scrubbed: the real addresses, the Prowlarr API key, the qBittorrent username, password and
// session cookie, every query value in Prowlarr's links (they hold the API key and the indexer's
// passkey), ID-like path segments, the trackers in magnets, and the trackers in .torrent files.
// Anonymized (see anonymize.ts): private indexers' names and hosts, .torrent files (rebuilt so their
// info-hash can't be traced back; the new hash replaces the real one everywhere), the hashes of
// private torrents in qBittorrent's list, and the time of day. qBittorrent's torrent list keeps only
// the fields mangarr reads. Before anything is written, the recording is checked for every secret
// and every private tracker name; any hit aborts.

import { createHmac, randomBytes } from "node:crypto";
import { stringsOutsideInfo } from "../src/integrations/torrent";
import { type RunCall, type RunRecording, recordedServices, type Service } from "../test/run-replay";
import {
  anonymizeTorrent,
  fakeHash,
  type IndexerInfo,
  realsIn,
  recordedOn,
  remapHashes,
  type TrackerAliases,
  trackerAliases,
} from "./anonymize";

export interface RecorderOptions {
  /** Left out when only qBittorrent is recorded. */
  prowlarrUrl?: string;
  prowlarrApiKey?: string;
  qbittorrentUrl: string;
  qbittorrentUsername: string;
  qbittorrentPassword: string;
  /** Hide every torrent's info-hash, not only private ones (recordings that stand alone). */
  hideEveryHash?: boolean;
}

/** Query parameters in Prowlarr's links that can be kept. Every other value is replaced. */
const safeParams = new Set(["file", "xt", "dn"]);
/** Path segments that may be a passkey or token. */
const tokenSegment = /^[A-Za-z0-9_-]{16,}$/;
/** The fields of qBittorrent's torrent list that are kept (others hold tracker URLs and magnets). */
const torrentFields = [
  "hash",
  "name",
  "category",
  "state",
  "progress",
  "amount_left",
  "size",
  "save_path",
  "eta",
  "dlspeed",
  "num_seeds",
  "num_leechs",
];

const base = (url: string) => url.trim().replace(/\/+$/, "");
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

export function createRunRecorder(options: RecorderOptions) {
  const realFetch = globalThis.fetch;
  const services: Partial<Record<Service, string>> = { qbittorrent: base(options.qbittorrentUrl) };
  if (options.prowlarrUrl) services.prowlarr = base(options.prowlarrUrl);
  const prowlarrApiKey = options.prowlarrApiKey ?? "";
  let calls: RunCall[] = [];

  /** Value → where it came from. Everything here must be absent from the recording. */
  const secrets = new Map<string, string>();
  const addSecret = (value: string, source: string) => {
    if (value.length >= 4) secrets.set(value, source);
  };
  addSecret(prowlarrApiKey, "the Prowlarr API key");
  addSecret(options.qbittorrentPassword, "the qBittorrent password");
  if (options.qbittorrentUsername.length >= 4) addSecret(options.qbittorrentUsername, "the qBittorrent username");
  for (const [service, url] of Object.entries(services)) {
    const host = new URL(url).host;
    if (host !== new URL(recordedServices[service as Service]).host) addSecret(host, `the ${service} address`);
  }

  /** Same value → same stand-in within a run (a guid matches across fields), never reversible. */
  const pseudonymKey = randomBytes(32);
  const pseudonym = (value: string) =>
    `redacted-${createHmac("sha256", pseudonymKey).update(value).digest("hex").slice(0, 12)}`;

  /** Private indexers' stand-ins, loaded from Prowlarr before its first recorded call. */
  let aliases: TrackerAliases = trackerAliases([]);
  let aliasesLoaded: Promise<void> | undefined;
  async function loadAliases() {
    const response = await realFetch(`${services.prowlarr}/api/v1/indexer`, {
      headers: { "X-Api-Key": prowlarrApiKey, Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`Could not list Prowlarr's indexers to anonymize the recording (${response.status})`);
    aliases = trackerAliases((await response.json()) as IndexerInfo[]);
  }

  /** Real info-hash → its stand-in, replaced everywhere when calls are handed out. */
  const hashes = new Map<string, string>();
  const hideHash = (real: string, fake: string) => {
    const hash = real.toLowerCase();
    if (hashes.has(hash)) return;
    hashes.set(hash, fake);
    addSecret(hash, "a private torrent's info-hash");
  };
  const remap = <T>(value: T): T => remapHashes(value, hashes);

  function scrubUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "magnet:") return value;
    for (const name of [...url.searchParams.keys()]) {
      if (!safeParams.has(name.toLowerCase())) url.searchParams.set(name, "REDACTED");
    }
    if (url.protocol !== "magnet:") {
      url.pathname = url.pathname
        .split("/")
        .map((segment) => (tokenSegment.test(segment) ? pseudonym(segment) : segment))
        .join("/");
    }
    url.username = "";
    url.password = "";
    return url.toString();
  }

  function scrubString(value: string): string {
    let out = value;
    for (const [service, url] of Object.entries(services))
      out = out.replaceAll(url, recordedServices[service as Service]);
    if (prowlarrApiKey) out = out.replaceAll(prowlarrApiKey, "REDACTED");
    return scrubUrl(aliases.scrub(out));
  }

  function scrub(value: unknown): unknown {
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    return value;
  }

  /** The torrent with one placeholder tracker and an `info` dictionary that can't be traced back. */
  function scrubTorrent(bytes: Uint8Array): Uint8Array {
    for (const text of stringsOutsideInfo(bytes)) {
      if (!text.includes("://")) continue;
      addSecret(text, `a tracker URL in the .torrent`);
      try {
        const url = new URL(text);
        for (const part of [...url.pathname.split("/"), ...url.searchParams.values()]) {
          if (tokenSegment.test(part)) addSecret(part, "a passkey in the .torrent's tracker URL");
        }
      } catch {
        // Not a URL after all.
      }
    }
    const torrent = anonymizeTorrent(bytes, pseudonymKey);
    hideHash(torrent.realHash, torrent.fakeHash);
    return torrent.bytes;
  }

  async function capture(service: Service, request: Request, response: Response): Promise<RunCall> {
    const url = new URL(request.url);
    const path = url.pathname.slice(new URL(services[service]!).pathname.replace(/\/$/, "").length);
    const isDownload = service === "prowlarr" && /^\/\d+\/download$/.test(path);
    // Download links come from Prowlarr's answers and get the same scrubbing as those answers.
    const query: [string, string][] = isDownload
      ? [...new URL(scrubUrl(scrubString(request.url))).searchParams]
      : [...url.searchParams].map(([k, v]) => [k, scrubString(v)]);

    let body: unknown;
    if (service === "qbittorrent" && request.method === "POST") {
      const type = request.headers.get("content-type") ?? "";
      if (path.endsWith("/auth/login")) body = { username: "REDACTED", password: "REDACTED" };
      else if (type.includes("multipart/form-data")) {
        const form = await request.formData();
        body = Object.fromEntries(
          [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? scrubString(v) : `<${v.size}-byte file>`]),
        );
      } else body = scrub(Object.fromEntries(new URLSearchParams(await request.text())));
    }

    const recorded: RunCall["response"] = {
      status: response.status,
      contentType: response.headers.get("content-type"),
    };
    const location = response.headers.get("location");
    if (location) recorded.location = scrubString(location);
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) recorded.setCookie = cookies.map((c) => `${c.split("=")[0]}=redacted`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (isDownload && response.ok && bytes[0] === 0x64) {
      recorded.bodyBase64 = Buffer.from(scrubTorrent(bytes)).toString("base64");
    } else if (bytes.length > 0) {
      const text = new TextDecoder().decode(bytes);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Keep it as text.
      }
      if (service === "qbittorrent" && path.endsWith("/torrents/info") && Array.isArray(parsed)) {
        for (const t of parsed as Record<string, unknown>[]) {
          const fromPrivateTracker = t.private === true || realsIn(String(t.tracker ?? ""), aliases.reals).length > 0;
          if ((options.hideEveryHash || fromPrivateTracker) && typeof t.hash === "string")
            hideHash(t.hash, fakeHash(t.hash, pseudonymKey));
        }
        parsed = parsed.map((t: Record<string, unknown>) =>
          Object.fromEntries(torrentFields.filter((f) => f in t).map((f) => [f, t[f]])),
        );
      }
      recorded.body = scrub(parsed);
    }
    return {
      service,
      request: { method: request.method, path, query, ...(body === undefined ? {} : { body }) },
      response: recorded,
    };
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const service = (Object.keys(services) as Service[]).find((s) => request.url.startsWith(`${services[s]}/`));
    if (!service) return realFetch(request);
    if (service === "prowlarr") {
      aliasesLoaded ??= loadAliases();
      await aliasesLoaded;
    }
    const sent = request.clone() as Request;
    const response = await realFetch(request);
    calls.push(await capture(service, sent, response.clone() as Response));
    return response;
  };

  /** Where secrets were found in `value` and in the .torrent bodies of `recorded`. */
  function leaksIn(value: unknown, recorded: RunCall[]): string[] {
    const texts = [
      JSON.stringify(value),
      ...recorded.flatMap((c) => (c.response.bodyBase64 ? [latin1(Buffer.from(c.response.bodyBase64, "base64"))] : [])),
    ];
    const found = [...secrets]
      .filter(([secret]) => texts.some((text) => text.includes(secret)))
      .map(([, source]) => source);
    for (const real of texts.flatMap((text) => realsIn(text, aliases.reals)))
      found.push(`a private tracker's name or address ("${real}")`);
    return [...new Set(found)];
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    /** The recording, or the list of secrets found in it. */
    finish(details: Omit<RunRecording, "calls" | "recordedAt">): { recording: RunRecording } | { leaks: string[] } {
      const recording: RunRecording = remap({ ...(scrub(details) as typeof details), recordedAt: recordedOn(), calls });
      const leaks = leaksIn(recording, calls);
      return leaks.length > 0 ? { leaks } : { recording };
    },
    /** Where secrets were found in anything else about to be written. */
    leaksIn: (value: unknown) => leaksIn(value, []),
    /** `value` with private torrents' info-hashes replaced, as in the recorded calls. */
    remap,
    /** Hides these info-hashes from the start, for hashes a recording uses before it lists them. */
    hideHashes(list: string[]) {
      for (const hash of list) hideHash(hash, fakeHash(hash, pseudonymKey));
    },
    /** The calls recorded since the last take, or the list of secrets found in them. Starts a new list. */
    takeCalls(): { calls: RunCall[] } | { leaks: string[] } {
      const taken = remap(calls);
      calls = [];
      const leaks = leaksIn(taken, taken);
      return leaks.length > 0 ? { leaks } : { calls: taken };
    },
  };
}
