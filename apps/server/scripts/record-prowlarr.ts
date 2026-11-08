// Records real Prowlarr API calls as test fixtures, with secrets scrubbed. The recordings prove the
// client and Prowlarr agree (what it sends, what it gets back); parser coverage lives in release-parser.
//
//   bun scripts/record-prowlarr.ts --indexer 1 --indexer 2 [--query berserk] [--category 7000]
//
// Records: status, the indexer list, one search per indexer (its own file, since each indexer's
// results look different), one search with no results, and two errors.
// Reads PROWLARR_URL and PROWLARR_API_KEY from the environment (Bun loads them from a .env file in
// the current directory; .env is gitignored). Replaces test/fixtures/prowlarr/*.json.
//
// Private indexers get a stand-in name and host, and recordings carry only the day (see anonymize.ts).
// Before anything is written, every fixture is checked for the API key, the real Prowlarr address,
// every credential stored in Prowlarr's indexer settings, and every private indexer's real name.
// Any hit aborts the recording.

import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { replaceFixtures } from "../test/fixtures";
import { recordedApiKey as fakeKey, recordedUrl as fakeUrl, type Recording } from "../test/prowlarr-replay";
import { type IndexerInfo, realsIn, recordedOn, type TrackerAliases, trackerAliases } from "./anonymize";

const { values } = parseArgs({
  options: {
    indexer: { type: "string", multiple: true, default: [] },
    /** Should find manga on every indexer. */
    query: { type: "string", default: "berserk" },
    /** mangarr always searches with categories; 7000 is Books. */
    category: { type: "string", multiple: true, default: ["7000"] },
    out: { type: "string", default: join(import.meta.dir, "../test/fixtures/prowlarr") },
  },
});

const realUrl = (process.env.PROWLARR_URL ?? "").trim().replace(/\/+$/, "");
const apiKey = (process.env.PROWLARR_API_KEY ?? "").trim();
if (!realUrl || !apiKey) {
  console.error("Set PROWLARR_URL and PROWLARR_API_KEY (for example in apps/server/.env).");
  process.exit(1);
}
const indexerIds = values.indexer.map(Number);
const categories = values.category.map((c) => String(Number(c)));
if (indexerIds.length === 0 || indexerIds.some((id) => !Number.isInteger(id))) {
  console.error("Give at least one --indexer <id>. List indexers with: bun run prowlarr:search --list-indexers");
  process.exit(1);
}

// ---- Scrubbing ----

/** Query parameters that can be kept in URLs. Every other value is replaced. */
const safeParams = new Set(["file", "id", "t", "q", "xt", "dn", "page", "cat", "type", "view"]);
/** Path segments that may be a passkey or token. */
const tokenSegment = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Stands in for an ID or token in a URL path: different values stay different and the same value
 * matches across fields (guid, infoUrl), but the key is random and never saved, so it can't be reversed.
 */
const pseudonymKey = randomBytes(32);
const pseudonym = (value: string) =>
  `redacted-${createHmac("sha256", pseudonymKey).update(value).digest("hex").slice(0, 12)}`;

/** The API key and every credential in Prowlarr's indexer settings, so we can prove none leaked. Value → where it came from. */
const secrets = new Map<string, string>([[apiKey, "the Prowlarr API key"]]);

/** Private indexers' stand-ins, set when the indexer list is recorded (before any search). */
let aliases: TrackerAliases = trackerAliases([]);

/** Indexer fields holding credentials: Prowlarr marks them with a privacy level, and the names give away the rest. */
const isCredentialField = (field: { name?: string; privacy?: string }) =>
  (field.privacy !== undefined && field.privacy !== "normal") ||
  /cookie|pass|key|token|user|login|secret|rss|auth|uid|sid/i.test(field.name ?? "");

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
  let out = value.replaceAll(realUrl, fakeUrl).replaceAll(apiKey, fakeKey);
  // Credentials from the indexer settings, collected when the indexer list is recorded (before any search).
  for (const secret of secrets.keys()) if (secret !== apiKey) out = out.replaceAll(secret, "REDACTED");
  return scrubUrl(aliases.scrub(out));
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner)]));
  }
  return value;
}

/** Indexer settings hold cookies, passkeys, usernames and passwords: keep only the field names. */
function scrubIndexers(body: unknown): unknown {
  if (!Array.isArray(body)) return scrub(body);
  aliases = trackerAliases(body as IndexerInfo[]);
  return body.map((indexer: Record<string, unknown>) => {
    const fields = (indexer.fields as { name?: string; privacy?: string; value?: unknown }[] | undefined) ?? [];
    for (const field of fields) {
      if (isCredentialField(field)) collectSecrets(field.value, `${indexer.name}'s "${field.name}" setting`);
    }
    return scrub({ ...indexer, fields: fields.map((field) => ({ name: field.name })) });
  });
}

function collectSecrets(value: unknown, source: string) {
  // Prowlarr shows stored passwords as asterisks.
  if (typeof value === "string" && value.length >= 4 && !/^\*+$/.test(value)) secrets.set(value, source);
  else if (Array.isArray(value)) for (const inner of value) collectSecrets(inner, source);
}

// ---- Calls ----

async function call(path: string, query: [string, string][], key = apiKey) {
  const search = new URLSearchParams(query).toString();
  const response = await fetch(`${realUrl}/api/v1/${path}${search ? `?${search}` : ""}`, {
    headers: { "X-Api-Key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep it as text.
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

const recordings = new Map<string, Recording>();
const recordedAt = recordedOn();
let prowlarrVersion = "unknown";

async function record(
  name: string,
  description: string,
  path: string,
  query: [string, string][],
  options: { key?: string; scrubBody?: (body: unknown) => unknown } = {},
) {
  const started = performance.now();
  const response = await call(path, query, options.key);
  const body = (options.scrubBody ?? scrub)(response.body);
  const count = Array.isArray(response.body) ? ` (${response.body.length} items)` : "";
  console.log(`${name}: ${response.status}${count} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  recordings.set(name, {
    description,
    recordedAt,
    prowlarrVersion,
    request: { method: "GET", path: `/api/v1/${path}`, query },
    response: { ...response, body },
  });
  return response;
}

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const status = await record("status", "GET /system/status", "system/status", []);
prowlarrVersion = (status.body as { version?: string }).version ?? "unknown";
for (const recording of recordings.values()) recording.prowlarrVersion = prowlarrVersion;

const indexers = await record(
  "indexers",
  "GET /indexer; each indexer's settings reduced to field names",
  "indexer",
  [],
  {
    scrubBody: scrubIndexers,
  },
);
const names = new Map(
  (indexers.body as { id: number; name: string }[]).map(
    (indexer) => [indexer.id, aliases.scrub(indexer.name)] as const,
  ),
);

/** The query string the client sends for a search (same keys, in the same order). */
const searchQuery = (query: string, indexerId: number): [string, string][] => [
  ["query", query],
  ["type", "search"],
  ["indexerIds", String(indexerId)],
  ...categories.map((c): [string, string] => ["categories", c]),
];
const inCategories = categories.length > 0 ? `, categories ${categories.join(", ")}` : "";

for (const id of indexerIds) {
  const name = names.get(id);
  if (!name) throw new Error(`Prowlarr has no indexer ${id}`);
  await record(
    `search-${slug(name)}`,
    `Search "${values.query}" on ${name}${inCategories}`,
    "search",
    searchQuery(values.query, id),
  );
}

const noResults = "zzqxw nothing matches";
await record(
  "search-no-results",
  `Search "${noResults}" on ${names.get(indexerIds[0]!)}${inCategories}`,
  "search",
  searchQuery(noResults, indexerIds[0]!),
);

await record("error-unknown-indexer", "Search on an indexer ID that doesn't exist", "search", [
  ["query", "one piece"],
  ["type", "search"],
  ["indexerIds", "999999"],
]);
await record("error-wrong-api-key", "Any call with a wrong API key", "system/status", [], { key: "f".repeat(32) });

// ---- Leak check, then write ----

const realHost = new URL(realUrl).host;
const leaks: string[] = [];
for (const [name, recording] of recordings) {
  const json = JSON.stringify(recording);
  for (const [secret, source] of secrets) {
    if (json.includes(secret)) leaks.push(`${name}: contains ${source}`);
  }
  if (realHost !== new URL(fakeUrl).host && json.includes(realHost)) leaks.push(`${name}: contains ${realHost}`);
  for (const real of realsIn(json, aliases.reals))
    leaks.push(`${name}: contains a private indexer's name or address ("${real}")`);
}
if (leaks.length > 0) {
  console.error(`Not writing anything, secrets found:\n${[...new Set(leaks)].join("\n")}`);
  process.exit(1);
}

replaceFixtures(values.out, recordings);
console.log(`\nWrote ${recordings.size} fixtures to ${values.out} (checked against ${secrets.size} known secrets)`);
