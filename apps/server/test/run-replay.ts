// Replays a whole recorded run (scripts/try-run.ts --record): every Prowlarr and qBittorrent call
// from search to import, scrubbed of secrets (test/fixtures/runs/*.json).

import { join } from "node:path";
import type { Db } from "../src/db/client";
import { languages, searchTerms, series } from "../src/db/schema";
import type { Fetch } from "../src/integrations/upstream";
import { joinPath, sanitizeName } from "../src/library/paths";
import { setSetting } from "../src/settings";
import { fixtureNames, loadFixture } from "./fixtures";

export const runsDir = join(import.meta.dir, "fixtures/runs");

/** The addresses recordings use in place of the real ones. */
export const recordedServices = { prowlarr: "http://prowlarr:9696", qbittorrent: "http://qbittorrent:8080" } as const;
export type Service = keyof typeof recordedServices;

export interface RunCall {
  service: Service;
  request: {
    method: string;
    /** Below the service's base URL, e.g. `/api/v2/torrents/info`. */
    path: string;
    query: [string, string][];
    /** What was sent, for whoever reads the fixture (never matched). */
    body?: unknown;
  };
  response: {
    status: number;
    contentType: string | null;
    location?: string;
    /** Cookie names only, e.g. `QBT_SID_8081=redacted`. */
    setCookie?: string[];
    /** JSON or text. */
    body?: unknown;
    /** For binary bodies (.torrent files). */
    bodyBase64?: string;
  };
}

export interface RunRecording {
  description: string;
  recordedAt: string;
  qbittorrentVersion?: string;
  /** What the run did and got, so the replay can check it gets the same. */
  run: {
    query: string;
    indexerIds: number[];
    categories: number[];
    name: string;
    aliases: string[];
    authors: string[];
    volumeCount: number | null;
    qbittorrentCategory: string;
    /** The title of the grabbed result. */
    release: string;
    match: "exact" | "partial" | "none";
    infoHash: string;
    status: "imported" | "needs_attention";
    importLog: { sourceFile: string; action: string; volumeNumber: number | null }[];
    libraryFiles: string[];
  };
  calls: RunCall[];
}

export interface RunServices {
  prowlarrUrl: string;
  prowlarrApiKey: string;
  qbittorrentUrl: string;
  qbittorrentUsername: string;
  qbittorrentPassword: string;
}

export type RunSeries = Pick<
  RunRecording["run"],
  "query" | "indexerIds" | "categories" | "name" | "aliases" | "authors" | "volumeCount" | "qbittorrentCategory"
>;

/**
 * What a run starts from, in try-run.ts and again in its replay: the service settings, and one
 * language and series in `library`, searched by `query` with the name and aliases as aliases.
 */
export function seedRun(db: Db, library: string, services: RunServices, run: RunSeries) {
  for (const [key, value] of Object.entries(services)) setSetting(db, key as keyof RunServices, value);
  setSetting(db, "qbittorrentCategory", run.qbittorrentCategory);
  const language = db
    .insert(languages)
    .values({
      code: "try",
      name: "Try run",
      rootFolder: library,
      prowlarrIndexerIds: run.indexerIds,
      prowlarrCategories: run.categories,
    })
    .returning()
    .get();
  const target = db
    .insert(series)
    .values({
      languageId: language.id,
      mangabakaId: 0,
      displayTitle: run.name,
      folderPath: joinPath(library, sanitizeName(run.name)),
      authors: run.authors,
      volumeCount: run.volumeCount,
    })
    .returning()
    .get();
  const aliases = [...new Set([run.name, ...run.aliases].filter((n) => n !== run.query))];
  db.insert(searchTerms)
    .values([
      { seriesId: target.id, term: run.query, kind: "search" as const },
      ...aliases.map((term) => ({ seriesId: target.id, term, kind: "alias" as const })),
    ])
    .run();
  return target;
}

export const loadRun = (name: string) => loadFixture<RunRecording>(runsDir, name);

export const recordedRuns = () => fixtureNames(runsDir);

const callKey = (method: string, path: string, query: Iterable<[string, string]>) =>
  `${method} ${path}?${[...query]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&")}`;

/**
 * A fetch that answers from the recording. Calls with the same method, path and query are answered
 * in recorded order (so polling sees qBittorrent's states one after another), and the last answer
 * repeats once they run out. A call nothing recorded throws.
 */
export function replayRun(recording: { calls: RunCall[] }): Fetch & { requests: Request[] } {
  const answers = new Map<string, RunCall[]>();
  for (const call of recording.calls) {
    const key = `${call.service} ${callKey(call.request.method, call.request.path, call.request.query)}`;
    answers.set(key, [...(answers.get(key) ?? []), call]);
  }
  const used = new Map<string, number>();
  const requests: Request[] = [];

  const fetch = async (request: Request) => {
    requests.push(request);
    const url = new URL(request.url);
    const service = (Object.keys(recordedServices) as Service[]).find(
      (s) => url.origin === new URL(recordedServices[s]).origin,
    );
    if (!service) throw new Error(`No recorded service at ${url.origin}`);
    const key = `${service} ${callKey(request.method, url.pathname, url.searchParams)}`;
    const list = answers.get(key);
    if (!list) throw new Error(`No recording for ${service} ${request.method} ${url.pathname}${url.search}`);
    const index = used.get(key) ?? 0;
    used.set(key, index + 1);
    const { response } = list[Math.min(index, list.length - 1)]!;

    const headers = new Headers();
    if (response.contentType) headers.set("content-type", response.contentType);
    if (response.location) headers.set("location", response.location);
    for (const cookie of response.setCookie ?? []) headers.append("set-cookie", cookie);
    const body =
      response.bodyBase64 !== undefined
        ? Buffer.from(response.bodyBase64, "base64")
        : response.body === undefined
          ? null
          : typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body);
    return new Response(response.status === 204 || response.status === 304 ? null : body, {
      status: response.status,
      headers,
    });
  };
  return Object.assign(fetch, { requests });
}
