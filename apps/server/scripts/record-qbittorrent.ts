// Records real qBittorrent Web API calls as test fixtures, one per scenario in
// test/qbittorrent-scenarios.ts, with secrets scrubbed (see run-recorder.ts). The recordings prove
// the client and qBittorrent agree, including on failures the end-to-end runs never hit.
//
//   bun run qbittorrent:record [--category mangarr]
//
// Reads QBITTORRENT_URL, QBITTORRENT_USERNAME and QBITTORRENT_PASSWORD from the environment (Bun
// loads them from apps/server/.env). Needs at least one torrent in the category, e.g. one grabbed
// with `bun run try:run`. Replaces test/fixtures/qbittorrent/*.json.
//
// What it changes in qBittorrent, and undoes: it creates a category named "mangarr-recorder-test"
// and removes it at the end. Adding a magnet for a torrent qBittorrent already has changes nothing.
// One login uses a wrong password on purpose; qBittorrent only bans an IP after several.

import { parseArgs } from "node:util";
import { createQBittorrentClient } from "../src/integrations/qbittorrent";
import { replaceFixtures } from "../test/fixtures";
import {
  asStored,
  type QBittorrentRecording,
  qbittorrentFixturesDir,
  type ScenarioContext,
  scenarios,
} from "../test/qbittorrent-scenarios";
import { recordedOn } from "./anonymize";
import { createRunRecorder } from "./run-recorder";

const { values } = parseArgs({ options: { category: { type: "string", default: "mangarr" } } });

const url = (process.env.QBITTORRENT_URL ?? "").trim().replace(/\/+$/, "");
const username = (process.env.QBITTORRENT_USERNAME ?? "").trim();
const password = process.env.QBITTORRENT_PASSWORD ?? "";
if (!url) {
  console.error(
    "Set QBITTORRENT_URL, QBITTORRENT_USERNAME and QBITTORRENT_PASSWORD (for example in apps/server/.env).",
  );
  process.exit(1);
}

const realFetch = globalThis.fetch;
// These recordings stand alone, so every info-hash is replaced: none ties them to a tracker account.
const recorder = createRunRecorder({
  qbittorrentUrl: url,
  qbittorrentUsername: username,
  qbittorrentPassword: password,
  hideEveryHash: true,
});

// Not recorded: what the scenarios need to know beforehand.
const plain = createQBittorrentClient({ url, username, password, fetch: (request) => realFetch(request) });
const qbittorrentVersion = await plain.version();
const inCategory = await plain.torrents({ category: values.category });
const [known] = inCategory;
if (!known) {
  console.error(
    `qBittorrent has no torrent in the "${values.category}" category. Grab one first, e.g. with bun run try:run.`,
  );
  process.exit(1);
}
recorder.hideHashes(inCategory.map((t) => t.hash));
const realContext: ScenarioContext = {
  knownHash: known.hash,
  category: values.category,
  newCategory: "mangarr-recorder-test",
};
/** As stored: the known hash replaced like in the calls. */
const context = recorder.remap(realContext);

/** Removes the scenario's category again, outside the recording (mangarr itself never removes anything). */
async function removeTestCategory() {
  const login = await realFetch(`${url}/api/v2/auth/login`, {
    method: "POST",
    headers: { Referer: url },
    body: new URLSearchParams({ username, password }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const response = await realFetch(`${url}/api/v2/torrents/removeCategories`, {
    method: "POST",
    headers: { Referer: url, Cookie: cookie },
    body: new URLSearchParams({ categories: context.newCategory }),
  });
  console.log(`removed the "${context.newCategory}" category: ${response.status}`);
}

const recordings = new Map<string, QBittorrentRecording>();
const leaks: string[] = [];
try {
  for (const [name, scenario] of Object.entries(scenarios)) {
    recorder.takeCalls();
    const client = createQBittorrentClient({
      url,
      username,
      password: scenario.wrongPassword ? `${password}-not-it` : password,
      fetch: recorder.fetch,
    });
    const outcome = recorder.remap(asStored(await scenario.run(client, realContext)));
    const taken = recorder.takeCalls();
    if ("leaks" in taken) {
      leaks.push(...taken.leaks.map((leak) => `${name}: ${leak}`));
      continue;
    }
    leaks.push(...recorder.leaksIn(outcome).map((leak) => `${name}: ${leak}`));
    recordings.set(name, {
      description: scenario.description,
      recordedAt: recordedOn(),
      qbittorrentVersion,
      context,
      outcome,
      calls: taken.calls,
    });
    console.log(`${name}: ${taken.calls.length} call(s)`);
  }
} finally {
  await removeTestCategory();
}

if (leaks.length > 0) {
  console.error(`Not writing anything, secrets found:\n  ${[...new Set(leaks)].join("\n  ")}`);
  process.exit(1);
}

replaceFixtures(qbittorrentFixturesDir, recordings);
console.log(`\nWrote ${recordings.size} fixtures to ${qbittorrentFixturesDir} (qBittorrent ${qbittorrentVersion})`);
