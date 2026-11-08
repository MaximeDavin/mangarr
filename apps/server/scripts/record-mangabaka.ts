// Records real MangaBaka API calls as test fixtures (test/fixtures/mangabaka/*.json), so the client
// is tested against what MangaBaka really returns. The API is public: there are no secrets to scrub.
//
//   bun scripts/record-mangabaka.ts
//
// Series records lose the fields mangarr never reads (see `slimRecord`), which are most of their size.
// Replaces test/fixtures/mangabaka/*.json.

import { join } from "node:path";
import { mangabakaUrl, slimRecord } from "../src/integrations/mangabaka";
import { replaceFixtures } from "../test/fixtures";
import { recordedOn } from "./anonymize";
import type { RecordedCall } from "../test/replay";

const out = join(import.meta.dir, "../test/fixtures/mangabaka");

interface Plan {
  name: string;
  description: string;
  path: string;
  query?: [string, string][];
}

const plans: Plan[] = [
  {
    name: "search-berserk",
    description: "Search as the add-series flow sends it: novels left out.",
    path: "/v1/series/search",
    query: [
      ["q", "berserk"],
      ["limit", "5"],
      ["type_not", "novel"],
    ],
  },
  { name: "series-berserk", description: "A releasing series with no collections.", path: "/v1/series/1692" },
  {
    name: "collections-berserk",
    description: "No collections: the volume count falls back to final_volume.",
    path: "/v1/series/1692/collections",
    query: [
      ["page", "1"],
      ["limit", "50"],
    ],
  },
  { name: "series-blue-lock", description: "A series with English collections in several editions.", path: "/v1/series/83" },
  {
    name: "collections-blue-lock",
    description: "Standard, omnibus and box-set editions; paperback and digital counts differ.",
    path: "/v1/series/83/collections",
    query: [
      ["page", "1"],
      ["limit", "50"],
    ],
  },
  { name: "series-not-found", description: "An ID MangaBaka doesn't have.", path: "/v1/series/2147483000" },
];

/** Search results and series records are slimmed like the cache. */
function slim(body: unknown): unknown {
  if (!body || typeof body !== "object" || !("data" in body)) return body;
  const data = (body as { data: unknown }).data;
  return { ...body, data: Array.isArray(data) ? data.map(slimRecord) : slimRecord(data) };
}

const recordings = new Map<string, RecordedCall>();
for (const plan of plans) {
  const query = plan.query ?? [];
  const url = `${mangabakaUrl}${plan.path}${query.length ? `?${new URLSearchParams(query)}` : ""}`;
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "mangarr" } });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = slim(JSON.parse(text));
  } catch {
    // Keep the text.
  }
  console.log(`${response.status} ${plan.path}`);
  recordings.set(plan.name, {
    description: plan.description,
    recordedAt: recordedOn(),
    request: { method: "GET", path: plan.path, query },
    response: { status: response.status, contentType: response.headers.get("content-type"), body },
  });
}

replaceFixtures(out, recordings);
console.log(`Wrote ${recordings.size} recordings to ${out}`);
