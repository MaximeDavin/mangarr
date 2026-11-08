// Records real Komga API calls as test fixtures, one per scenario in test/komga-scenarios.ts,
// with the address and API key scrubbed. The recordings prove the client and Komga agree.
//
//   bun run komga:record [--library <id>]
//
// Reads KOMGA_URL and KOMGA_API_KEY from the environment (Bun loads them from apps/server/.env).
// The key's user must be an admin. Uses the first library unless --library is given.
// Replaces test/fixtures/komga/*.json.
//
// What it changes in Komga: it asks for one scan of that library (new files only), as an import would.

import { parseArgs } from "node:util";
import { createKomgaClient } from "../src/integrations/komga";
import { replaceFixtures } from "../test/fixtures";
import {
  asStored,
  type KomgaCall,
  type KomgaRecording,
  komgaFixturesDir,
  komgaScenarios,
  recordedKomgaUrl,
} from "../test/komga-scenarios";
import { recordedOn } from "./anonymize";

const { values } = parseArgs({ options: { library: { type: "string" } } });

const url = (process.env.KOMGA_URL ?? "").trim().replace(/\/+$/, "");
const apiKey = (process.env.KOMGA_API_KEY ?? "").trim();
if (!url || !apiKey) {
  console.error("Set KOMGA_URL and KOMGA_API_KEY (for example in apps/server/.env).");
  process.exit(1);
}
const wrongKey = `${apiKey.slice(0, -4)}nope`;

const realFetch = globalThis.fetch;
const secrets = new Map<string, string>([
  [apiKey, "the Komga API key"],
  [wrongKey, "the wrong API key"],
]);
const host = new URL(url).host;
if (host !== new URL(recordedKomgaUrl).host) secrets.set(host, "the Komga address");

/** Komga's user records hold the account's email, which mangarr never reads. */
const scrub = (value: unknown): unknown => {
  if (typeof value === "string") return value.replaceAll(url, recordedKomgaUrl).replaceAll(apiKey, "REDACTED");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === "email" && typeof v === "string") {
          secrets.set(v, "the Komga account's email");
          return [k, "user@example.invalid"];
        }
        return [k, scrub(v)];
      }),
    );
  }
  return value;
};

let calls: KomgaCall[] = [];
const recordingFetch = async (request: Request): Promise<Response> => {
  const response = await realFetch(request.clone() as Request);
  const target = new URL(request.url);
  const text = await response.clone().text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  calls.push({
    request: {
      method: request.method,
      path: target.pathname.slice(new URL(url).pathname.replace(/\/$/, "").length),
      query: [...target.searchParams],
    },
    response: {
      status: response.status,
      contentType: response.headers.get("content-type"),
      ...(body === undefined ? {} : { body: scrub(body) }),
    },
  });
  return response;
};

// Not recorded: what the scenarios need to know beforehand.
const plain = createKomgaClient({ url, apiKey, fetch: (request) => realFetch(request) });
const libraries = await plain.libraries();
console.log(`Komga at ${url} has ${libraries.length} librar${libraries.length === 1 ? "y" : "ies"}:`);
for (const library of libraries) console.log(`  ${library.id}  ${library.name}  (${library.root})`);
const library = values.library ? libraries.find((l) => l.id === values.library) : libraries[0];
if (!library) {
  console.error(values.library ? `Komga has no library ${values.library}.` : "Komga has no library. Create one first.");
  process.exit(1);
}

/** Best effort: Komga's version, from its actuator (admins only). */
async function komgaVersion(): Promise<string | undefined> {
  try {
    const response = await realFetch(`${url}/actuator/info`, { headers: { "X-API-Key": apiKey } });
    if (!response.ok) return undefined;
    const info = (await response.json()) as { build?: { version?: unknown } };
    return typeof info.build?.version === "string" ? info.build.version : undefined;
  } catch {
    return undefined;
  }
}
const version = await komgaVersion();
if (version) console.log(`Komga version ${version}`);

const recordings = new Map<string, KomgaRecording>();
const leaks: string[] = [];
for (const [name, scenario] of Object.entries(komgaScenarios)) {
  calls = [];
  const client = createKomgaClient({ url, apiKey: scenario.wrongKey ? wrongKey : apiKey, fetch: recordingFetch });
  const context = { libraryId: library.id };
  const recording: KomgaRecording = {
    description: scenario.description,
    recordedAt: recordedOn(),
    ...(version ? { komgaVersion: version } : {}),
    context,
    outcome: scrub(asStored(await scenario.run(client, context))),
    calls,
  };
  const text = JSON.stringify(recording);
  const found = [...secrets].filter(([secret]) => text.includes(secret)).map(([, source]) => source);
  if (found.length > 0) leaks.push(...found.map((source) => `${name}: ${source}`));
  else recordings.set(name, recording);
  console.log(`\n${name}: ${scenario.description}`);
  console.log(JSON.stringify(recording.outcome, null, 2));
}

if (leaks.length > 0) {
  console.error(`\nNothing written: secrets left in the recordings:\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}
replaceFixtures(komgaFixturesDir, recordings);
console.log(`\nWrote ${recordings.size} recordings to ${komgaFixturesDir}`);
