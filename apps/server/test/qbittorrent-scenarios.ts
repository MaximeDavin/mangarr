// What scripts/record-qbittorrent.ts does against a real qBittorrent, one recording per scenario,
// and what test/qbittorrent-recorded.test.ts does again against each recording. Each scenario
// returns what the client got (values, or errors as { kind, status, message }), and the test
// checks the replay gets the same.

import { join } from "node:path";
import { type QBittorrentClient, QBittorrentError } from "../src/integrations/qbittorrent";
import { fixtureNames, loadFixture } from "./fixtures";
import type { RunCall } from "./run-replay";

export const qbittorrentFixturesDir = join(import.meta.dir, "fixtures/qbittorrent");

/** A hash no qBittorrent has. */
export const unknownHash = "0123456789abcdef0123456789abcdef01234567";

export interface ScenarioContext {
  /** A torrent the recorded qBittorrent has, in `category`. */
  knownHash: string;
  /** mangarr's category, which exists. */
  category: string;
  /** A category that doesn't exist yet (the recorder removes it again afterwards). */
  newCategory: string;
}

export interface QBittorrentRecording {
  description: string;
  recordedAt: string;
  qbittorrentVersion: string;
  context: ScenarioContext;
  /** What the client got. */
  outcome: unknown;
  calls: RunCall[];
}

type Outcome<T> = { ok: T } | { error: { kind: string; status?: number; message: string } };

async function outcome<T>(call: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await call };
  } catch (error) {
    if (!(error instanceof QBittorrentError)) throw error;
    return { error: { kind: error.kind, status: error.status, message: error.message } };
  }
}

/** As it is stored: JSON drops undefined fields. */
export const asStored = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

export interface Scenario {
  description: string;
  /** Log in with a wrong password. */
  wrongPassword?: boolean;
  run(client: QBittorrentClient, context: ScenarioContext): Promise<unknown>;
}

export const scenarios: Record<string, Scenario> = {
  "login-and-version": {
    description: "Log in and read the version (the connection test)",
    run: (client) => outcome(client.version()),
  },
  categories: {
    description: "Make sure mangarr's category exists (it does), then a new one (created)",
    run: async (client, { category, newCategory }) => ({
      existing: await outcome(client.ensureCategory(category)),
      created: await outcome(client.ensureCategory(newCategory)),
    }),
  },
  torrents: {
    description: "The torrent list by known and unknown hash and by category, and the file list by known and unknown hash",
    run: async (client, { knownHash, category }) => ({
      known: await outcome(client.torrents({ hashes: [knownHash] })),
      unknown: await outcome(client.torrents({ hashes: [unknownHash] })),
      inCategory: await outcome(client.torrents({ category })),
      files: await outcome(client.files(knownHash)),
      filesUnknown: await outcome(client.files(unknownHash)),
    }),
  },
  "add-duplicate": {
    description: "Add a magnet for a torrent qBittorrent already has (it changes nothing)",
    run: (client, { knownHash, category }) => outcome(client.add({ kind: "magnet", uri: `magnet:?xt=urn:btih:${knownHash}` }, category)),
  },
  // Last, so a ban (after several failures) can't spoil the others.
  "wrong-password": {
    description: "Log in with a wrong password",
    wrongPassword: true,
    run: (client) => outcome(client.version()),
  },
};

export const loadQBittorrentRecording = (name: string) => loadFixture<QBittorrentRecording>(qbittorrentFixturesDir, name);

export const recordedQBittorrentScenarios = () => fixtureNames(qbittorrentFixturesDir);
