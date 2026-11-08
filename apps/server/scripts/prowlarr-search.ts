// Prints parsed Prowlarr search results, as a preview of interactive search (spec §7.2).
//
//   bun scripts/prowlarr-search.ts --list-indexers
//   bun scripts/prowlarr-search.ts --lang fr "one piece"
//   bun scripts/prowlarr-search.ts --indexer 3 --indexer 5 --name "One Piece" --name "ワンピース" "one piece"
//
// The Prowlarr URL and API key come from the saved settings (in CONFIG_DIR), or from
// PROWLARR_URL and PROWLARR_API_KEY, which take precedence.

import { parseArgs } from "node:util";
import { parseRelease, titleMatch } from "@mangarr/release-parser";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { type Db, openDatabase } from "../src/db/client";
import { languages } from "../src/db/schema";
import { createProwlarrClient, ProwlarrError, type ProwlarrRelease } from "../src/integrations/prowlarr";
import { getSettings } from "../src/settings";
import { formatSize, formatVolumes } from "./format";

const usage = `Usage:
  bun scripts/prowlarr-search.ts --list-indexers
  bun scripts/prowlarr-search.ts (--lang <code> | --indexer <id>...) [options] <query>

Options:
  --lang <code>      Use that Language's indexers and categories from the database
  --indexer <id>     Indexer to search (repeatable)
  --category <id>    Category to search (repeatable; default: all)
  --name <name>      Series name for title matching (repeatable; default: the query)
  --author <name>    Series author for title matching (repeatable)
  --chapters         Also show chapter releases (interactive search drops them)
  --list-indexers    List Prowlarr's indexers and exit`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lang: { type: "string" },
    indexer: { type: "string", multiple: true, default: [] },
    category: { type: "string", multiple: true, default: [] },
    name: { type: "string", multiple: true, default: [] },
    author: { type: "string", multiple: true, default: [] },
    chapters: { type: "boolean", default: false },
    "list-indexers": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
}

function ids(list: string[], flag: string): number[] {
  return list.map((value) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) fail(`${flag} expects a positive number, got "${value}"`);
    return id;
  });
}

if (values.help) {
  console.log(usage);
  process.exit(0);
}

// Only open the database when something has to come from it (opening it runs migrations).
let db: Db | undefined;
const database = () => (db ??= openDatabase(loadConfig().databasePath));

const url = process.env.PROWLARR_URL || getSettings(database()).prowlarrUrl;
const apiKey = process.env.PROWLARR_API_KEY || getSettings(database()).prowlarrApiKey;
if (!url || !apiKey)
  fail("No Prowlarr URL or API key: save them in Settings, or set PROWLARR_URL and PROWLARR_API_KEY.");

const prowlarr = createProwlarrClient({ url, apiKey });

/** Prints a Prowlarr failure as one line instead of a stack trace. */
async function orExit<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (!(error instanceof ProwlarrError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

if (values["list-indexers"]) {
  const indexers = await orExit(prowlarr.indexers());
  for (const indexer of indexers.sort((a, b) => a.id - b.id)) {
    const flags = [indexer.protocol, indexer.privacy, indexer.language, indexer.enabled ? undefined : "disabled"];
    console.log(`${String(indexer.id).padStart(4)}  ${indexer.name}  (${flags.filter(Boolean).join(", ")})`);
  }
  process.exit(0);
}

const query = positionals.join(" ").trim();
if (!query) fail("Give a search query.");

let indexerIds = ids(values.indexer, "--indexer");
let categories = ids(values.category, "--category");
if (values.lang) {
  const language = database().select().from(languages).where(eq(languages.code, values.lang)).get();
  if (!language) fail(`No language with code "${values.lang}"`);
  if (indexerIds.length === 0) indexerIds = language.prowlarrIndexerIds;
  if (categories.length === 0) categories = language.prowlarrCategories;
}
if (indexerIds.length === 0) fail("No indexers to search: pass --indexer, or a --lang that has indexers.");

const target = { names: values.name.length > 0 ? values.name : [query], authors: values.author };

const started = performance.now();
const releases = await orExit(prowlarr.search({ query, indexerIds, categories }));
const seconds = ((performance.now() - started) / 1000).toFixed(1);

// Duplicates across indexers: by info-hash, falling back to guid (§7.2).
const unique = new Map<string, ProwlarrRelease>();
for (const release of releases) unique.set(release.infoHash ?? `guid:${release.guid}`, release);

const matchRank = { exact: 2, partial: 1, none: 0 };
const rows = [...unique.values()]
  .map((release) => {
    const parsed = parseRelease(release.title);
    return { release, parsed, match: titleMatch(parsed, target) ?? ("none" as const) };
  })
  .filter((row) => values.chapters || !row.parsed.isChapterRelease)
  .sort((a, b) => matchRank[b.match] - matchRank[a.match] || (b.release.seeders ?? -1) - (a.release.seeders ?? -1));

for (const { release, parsed, match } of rows) {
  const volumes =
    parsed.volumes.length > 0 ? `v${formatVolumes(parsed.volumes)}` : parsed.isComplete ? "complete" : "-";
  const notes = [
    parsed.isChapterRelease && "chapters",
    parsed.hasExtraChapters && "+chapters",
    parsed.editionHint,
    parsed.source,
    parsed.contentHint,
    parsed.group && `[${parsed.group}]`,
    release.protocol !== "torrent" && release.protocol,
    !release.infoHash && "no hash",
  ].filter(Boolean);

  console.log(
    `${match.padEnd(7)} ${String(release.seeders ?? "?").padStart(4)}s ${formatSize(release.size).padStart(9)}  ${release.indexer}`,
  );
  console.log(`        ${release.title}`);
  console.log(`        → ${parsed.title} · ${volumes}${notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}`);
}

const hidden = unique.size - rows.length;
console.log(
  `\n${releases.length} result(s), ${unique.size} unique, ${rows.length} shown` +
    `${hidden > 0 ? ` (${hidden} chapter release(s) hidden)` : ""} in ${seconds} s`,
);
