// Whole runs recorded from a real Prowlarr and qBittorrent (scripts/try-run.ts --record): search,
// grab, polling and import, replayed call for call. They prove mangarr and the real services agree
// on every step, including qBittorrent's states as a download moves along. The volume files are
// small stand-ins written where qBittorrent said it saved them.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client";
import { downloads, importLogEntries } from "../src/db/schema";
import { createPoller } from "../src/jobs/poller";
import { mappedCopyStrategy } from "../src/library/import";
import { normalizePath } from "../src/library/paths";
import { ReleaseCache } from "../src/library/release-cache";
import { ensureApiKey } from "../src/settings";
import { apiClient } from "./helpers";
import { loadRun, type RunRecording, recordedRuns, recordedServices, replayRun, seedRun } from "./run-replay";

let temp: string;
beforeEach(() => {
  temp = normalizePath(mkdtempSync(join(tmpdir(), "mangarr-run-")));
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
  mock.restore();
});

/** The files qBittorrent listed, and where it said it saved them. */
function torrentFiles(recording: RunRecording) {
  const answers = recording.calls.filter((c) => c.service === "qbittorrent" && c.response.status === 200);
  const files = answers.filter((c) => c.request.path.endsWith("/torrents/files")).at(-1)?.response.body as
    | { name: string }[]
    | undefined;
  const info = answers
    .filter((c) => c.request.path.endsWith("/torrents/info"))
    .flatMap((c) => c.response.body as { save_path?: string }[]);
  return { files: files ?? [], savePath: info.at(-1)?.save_path ?? "/downloads" };
}

const runs = recordedRuns();

it("has recorded runs to replay", () => {
  expect(runs.length).toBeGreaterThan(0);
});

describe.each(runs)("%s", (name) => {
  const recording = loadRun(name);
  const { run } = recording;

  it("goes from search to import as it did for real", async () => {
    const replay = replayRun(recording);
    spyOn(globalThis, "fetch").mockImplementation(replay as unknown as typeof fetch);

    // The same setup as try-run.ts, with the recordings' stand-in addresses.
    const db = openDatabase(":memory:");
    const services = {
      prowlarrUrl: recordedServices.prowlarr,
      prowlarrApiKey: "0123456789abcdef0123456789abcdef",
      qbittorrentUrl: recordedServices.qbittorrent,
      qbittorrentUsername: "REDACTED",
      qbittorrentPassword: "REDACTED",
    };
    const target = seedRun(db, `${temp}/library`, services, run);
    const { folderPath } = target;

    // Stand-ins for the downloaded files, where qBittorrent said they are.
    const { files, savePath } = torrentFiles(recording);
    const downloaded = `${temp}/torrents`;
    for (const file of files) {
      mkdirSync(dirname(join(downloaded, file.name)), { recursive: true });
      writeFileSync(join(downloaded, file.name), file.name);
    }
    const poller = createPoller(db, { strategy: mappedCopyStrategy(savePath, downloaded), intervalMs: () => 60_000 });
    const api = apiClient(db, { apiKey: ensureApiKey(db), releases: new ReleaseCache(), jobs: poller });
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});

    // Search: the grabbed release is found and matched the same way.
    const found = await api.releases.search({ id: target.id });
    const result = found.results.find((r) => r.title === run.release);
    expect(result?.match).toBe(run.match);

    // Grab: the info-hash computed from the magnet or .torrent is the one qBittorrent reported.
    const download = await api.releases.grab({ id: target.id, guid: result!.guid });
    expect(download.infoHash).toBe(run.infoHash);

    // Polling, until the import ends: one tick per recorded qBittorrent answer is plenty.
    const polls = recording.calls.filter((c) => c.request.path.endsWith("/torrents/info")).length;
    const statuses: string[] = [];
    for (let tick = 0; tick <= polls; tick++) {
      await poller.tick();
      const { status } = db
        .select({ status: downloads.status })
        .from(downloads)
        .where(eq(downloads.id, download.id))
        .get()!;
      if (statuses.at(-1) !== status) statuses.push(status);
      if (status === "imported" || status === "needs_attention") break;
    }
    expect(statuses.at(-1)).toBe(run.status);

    // Import: the same files, named the same way.
    const log = db
      .select({
        sourceFile: importLogEntries.sourceFile,
        action: importLogEntries.action,
        volumeNumber: importLogEntries.volumeNumber,
      })
      .from(importLogEntries)
      .where(eq(importLogEntries.downloadId, download.id))
      .orderBy(importLogEntries.id)
      .all();
    expect(log).toEqual(run.importLog as typeof log);
    const imported = (() => {
      try {
        return readdirSync(folderPath).sort();
      } catch {
        return [];
      }
    })();
    expect(imported).toEqual(run.libraryFiles);
  });
});
