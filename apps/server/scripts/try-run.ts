// A real end-to-end run against your Prowlarr and qBittorrent: search → grab → download → import
// (spec §7.2–§7.4). It drives the real procedures and the real poller in-process, on a throwaway
// in-memory database, and imports into a library folder of its own.
//
//   bun run try:run --indexer 1 "berserk"
//   bun run try:run --indexer 1 --name "Berserk" --author "Kentaro Miura" --path-map /data=D:/data "berserk"
//
// Reads PROWLARR_URL, PROWLARR_API_KEY, QBITTORRENT_URL, QBITTORRENT_USERNAME and
// QBITTORRENT_PASSWORD from the environment (Bun loads apps/server/.env, which is gitignored).
//
// The grabbed torrent stays in qBittorrent afterwards: mangarr never deletes torrents.

import { mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRouterClient, ORPCError } from "@orpc/server";
import { router } from "../src/api/router";
import { openDatabase } from "../src/db/client";
import { createMangaBakaClient } from "../src/integrations/mangabaka";
import { qbittorrentFromSettings } from "../src/integrations/qbittorrent";
import { createPoller } from "../src/jobs/poller";
import { copyStrategy, type ImportStrategy, mappedCopyStrategy } from "../src/library/import";
import { normalizePath, sanitizeName } from "../src/library/paths";
import { ReleaseCache } from "../src/library/release-cache";
import { ensureApiKey } from "../src/settings";
import { writeFixture } from "../test/fixtures";
import { type RunSeries, type RunServices, runsDir, seedRun } from "../test/run-replay";
import { formatSize, formatVolumes } from "./format";
import { createRunRecorder } from "./run-recorder";

const usage = `Usage:
  bun run try:run --indexer <id>... [options] <query>

Options:
  --indexer <id>          Prowlarr indexer to search (repeatable, required)
  --category <id>         Category to search (repeatable; default 7000, Books)
  --name <title>          Display title, used for file names and matching (default: the query)
  --alias <name>          Extra name accepted when matching (repeatable)
  --author <name>         Author, for author-first release names (repeatable)
  --volume-count <n>      Known number of volumes (for "covers missing")
  --library <folder>      Where volumes are imported (default: a new folder in the system temp folder)
  --path-map <from=to>    Read qBittorrent's paths from another place, e.g. /data=D:/data when qBittorrent
                          runs in Docker and saves to /data. Only this script maps paths.
                          (In Git Bash, prefix the command with MSYS_NO_PATHCONV=1, or it rewrites /data.)
  --qbit-category <name>  qBittorrent category (default mangarr)
  --pick <n|title>        Grab result n, or the result with exactly that title, without asking
  --yes                   Don't ask before grabbing
  --interval <seconds>    Poll interval (default 5)
  --record <name>         Save every Prowlarr and qBittorrent call, scrubbed of secrets, as
                          test/fixtures/runs/<name>.json for the replay test`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    indexer: { type: "string", multiple: true, default: [] },
    category: { type: "string", multiple: true, default: ["7000"] },
    name: { type: "string" },
    alias: { type: "string", multiple: true, default: [] },
    author: { type: "string", multiple: true, default: [] },
    "volume-count": { type: "string" },
    library: { type: "string" },
    "path-map": { type: "string" },
    "qbit-category": { type: "string", default: "mangarr" },
    pick: { type: "string" },
    yes: { type: "boolean", default: false },
    interval: { type: "string", default: "5" },
    record: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
}

function positive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`${flag} expects a positive number, got "${value}"`);
  return n;
}

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const query = positionals.join(" ").trim();
if (!query) fail("Give a search query.");
const indexerIds = values.indexer.map((v) => positive(v, "--indexer"));
if (indexerIds.length === 0) fail("Give at least one --indexer. List them with: bun run prowlarr:search --list-indexers");
const categories = values.category.map((v) => positive(v, "--category"));
const intervalSeconds = positive(values.interval, "--interval");
const volumeCount = values["volume-count"] ? positive(values["volume-count"], "--volume-count") : null;

const env = (key: string) => (process.env[key] ?? "").trim();
const missing = ["PROWLARR_URL", "PROWLARR_API_KEY", "QBITTORRENT_URL"].filter((key) => !env(key));
if (missing.length > 0) fail(`Set ${missing.join(", ")} (for example in apps/server/.env).`);
const services: RunServices = {
  prowlarrUrl: env("PROWLARR_URL"),
  prowlarrApiKey: env("PROWLARR_API_KEY"),
  qbittorrentUrl: env("QBITTORRENT_URL"),
  qbittorrentUsername: env("QBITTORRENT_USERNAME"),
  qbittorrentPassword: env("QBITTORRENT_PASSWORD"),
};

// ---- Path mapping (this script only) ----

let strategy: ImportStrategy = copyStrategy;
if (values["path-map"]) {
  const [from, to] = values["path-map"].split("=");
  if (!from || !to) fail(`--path-map expects from=to, got "${values["path-map"]}"`);
  strategy = mappedCopyStrategy(from, to);
}

// ---- A throwaway mangarr ----

const library = normalizePath(resolve(values.library ?? join(tmpdir(), `mangarr-try-${Date.now()}`)));
mkdirSync(library, { recursive: true });

if (values.record !== undefined && !/^[a-z0-9-]+$/.test(values.record)) fail("--record expects a name made of a-z, 0-9 and -");
const recorder = values.record === undefined ? undefined : createRunRecorder(services);
// The clients call the global fetch, so this sees every call.
if (recorder) globalThis.fetch = recorder.fetch;

const displayTitle = values.name?.trim() || query;
if (!sanitizeName(displayTitle)) fail("The display title has no usable characters for a folder name.");
const runSeries: RunSeries = {
  query,
  indexerIds,
  categories,
  name: displayTitle,
  aliases: values.alias,
  authors: values.author,
  volumeCount,
  qbittorrentCategory: values["qbit-category"],
};
const db = openDatabase(":memory:");
const apiKey = ensureApiKey(db);
const target = seedRun(db, library, services, runSeries);

const poller = createPoller(db, { strategy, intervalMs: () => intervalSeconds * 1000 });
const api = createRouterClient(router, {
  context: {
    db,
    headers: new Headers({ "x-api-key": apiKey }),
    mangabaka: createMangaBakaClient(),
    releases: new ReleaseCache(),
    jobs: poller,
  },
});

/** API errors as one line instead of a stack trace. */
async function orExit<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (!(error instanceof ORPCError)) throw error;
    console.error(`\n${error.message}`);
    poller.stop();
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  poller.stop();
  console.log("\nStopped. The torrent keeps going in qBittorrent; this run no longer watches it.");
  process.exit(130);
});

// ---- 1. Search ----

console.log(`Searching "${query}" on indexer(s) ${indexerIds.join(", ")}…`);
const found = await orExit(api.releases.search({ id: target.id }));
if (found.results.length === 0) {
  console.log(`No results (${found.received} received, ${found.chapterReleases} chapter releases dropped).`);
  process.exit(0);
}

const shown = found.results.slice(0, 40);
const width = String(shown.length).length;
shown.forEach((r, i) => {
  const volumes = r.volumes.length > 0 ? `v${formatVolumes(r.volumes)}` : r.isComplete ? "complete" : "-";
  const notes = [r.coversMissing && "covers missing", r.grabbed && "grabbed", r.contentHint, r.editionHint].filter(Boolean);
  console.log(
    `${String(i + 1).padStart(width)}. ${r.match.padEnd(7)} ${String(r.seeders ?? "?").padStart(4)}s ${formatSize(r.size).padStart(9)}  ${r.indexer}  ${volumes}` +
      (notes.length > 0 ? `  (${notes.join(", ")})` : ""),
  );
  console.log(`${" ".repeat(width + 2)}${r.title}`);
});
console.log(
  `\n${found.results.length} result(s)${found.results.length > shown.length ? `, first ${shown.length} shown` : ""}; ` +
    `${found.received} received, ${found.chapterReleases} chapter release(s) dropped.`,
);

// ---- 2. Grab ----

const answer = (values.pick ?? prompt(`\nGrab which one? (1-${shown.length}, empty to stop)`) ?? "").trim();
if (!answer) process.exit(0);
// A number, or an exact release title (stable across searches, unlike the order).
const choice = /^\d+$/.test(answer) ? shown[Number(answer) - 1] : found.results.find((r) => r.title === answer);
if (!choice) fail(/^\d+$/.test(answer) ? `Pick a number from 1 to ${shown.length}.` : `No result is titled "${answer}".`);

if (!values.yes) {
  const ok = prompt(`This adds "${choice.title}" (${formatSize(choice.size)}) to qBittorrent, which starts downloading it. Go on? [y/N]`);
  if (!/^y(es)?$/i.test(ok?.trim() ?? "")) process.exit(0);
}

const download = await orExit(api.releases.grab({ id: target.id, guid: choice.guid }));
console.log(`\nGrabbed. Info-hash ${download.infoHash}, expecting volume(s) ${formatVolumes(download.expectedVolumes) || "from the files"}.`);

// ---- 3. Wait for the download and the import ----

console.log(`Polling qBittorrent every ${intervalSeconds} s. Ctrl+C stops watching (the download goes on).\n`);
poller.start();

let last = "";
for (;;) {
  const { downloads: [current], clientError } = await orExit(api.downloads.list({}));
  if (!current) fail("The download disappeared from the database.");
  const client = current.client;
  const progress = client
    ? `${(client.progress * 100).toFixed(1)}%, ${client.state}, ${formatSize(client.downloadSpeed)}/s${
        client.eta === undefined ? "" : client.eta < 60 ? `, ${client.eta} s left` : `, ${Math.round(client.eta / 60)} min left`
      }`
    : "";
  const line = [current.status, progress, clientError && `qBittorrent: ${clientError}`, current.statusMessage].filter(Boolean).join(" · ");
  if (line !== last) console.log(`${new Date().toLocaleTimeString()}  ${line}`);
  last = line;
  if (current.status === "imported" || current.status === "needs_attention") break;
  await Bun.sleep(intervalSeconds * 1000);
}
poller.stop();

// ---- 4. What happened ----

const detail = await orExit(api.downloads.get({ id: download.id }));
console.log(`\n${detail.status === "imported" ? "Imported" : "Needs attention"}${detail.statusMessage ? `: ${detail.statusMessage}` : ""}\n`);
for (const entry of detail.importLog) {
  const volume = entry.volumeNumber === null ? "" : ` v${entry.volumeNumber}`;
  console.log(`  ${entry.action.padEnd(19)}${volume.padEnd(6)} ${entry.sourceFile}${entry.message ? `  (${entry.message})` : ""}`);
}

const folder = target.folderPath;
let files: string[] = [];
try {
  files = readdirSync(folder).sort();
} catch {
  // Not created: nothing was imported.
}
console.log(`\nLibrary folder: ${folder}`);
for (const file of files) console.log(`  ${file}`);

if (!values["path-map"] && detail.importLog.some((e) => e.action === "error" && e.message?.includes("ENOENT"))) {
  console.log(
    "\nThe files were not found at qBittorrent's paths from this computer. If qBittorrent runs in Docker, pass\n" +
      "--path-map with its download folder and where this computer can read it, e.g. --path-map /data=//server/data",
  );
}
console.log(`\nThe torrent stays in qBittorrent (category "${values["qbit-category"]}"). Remove it there when you're done.`);

// ---- 5. The recording ----

if (recorder && values.record) {
  let qbittorrentVersion: string | undefined;
  try {
    qbittorrentVersion = await qbittorrentFromSettings(db).client.version();
  } catch {
    // Only informative.
  }
  const result = recorder.finish({
    description: `Search "${query}" on ${choice.indexer}, grab "${choice.title}", wait for qBittorrent, import`,
    qbittorrentVersion,
    run: {
      ...runSeries,
      release: choice.title,
      match: choice.match,
      infoHash: download.infoHash,
      status: detail.status === "imported" ? "imported" : "needs_attention",
      importLog: detail.importLog.map(({ sourceFile, action, volumeNumber }) => ({ sourceFile, action, volumeNumber })),
      libraryFiles: files,
    },
  });
  if ("leaks" in result) {
    console.error(`\nNot writing the recording, secrets found in it:\n  ${result.leaks.join("\n  ")}`);
    process.exit(1);
  }
  const path = writeFixture(runsDir, values.record, result.recording);
  console.log(`\nRecorded ${result.recording.calls.length} calls to ${path}`);
}
