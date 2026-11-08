// Replays MangaBaka calls recorded by scripts/record-mangabaka.ts (test/fixtures/mangabaka/*.json).

import { join } from "node:path";
import { createMangaBakaClient, mangabakaUrl } from "../src/integrations/mangabaka";
import { fixtureNames, loadFixture } from "./fixtures";
import { type RecordedCall, replayAt } from "./replay";

const fixturesDir = join(import.meta.dir, "fixtures/mangabaka");

export const loadMangaBakaRecording = (name: string) => loadFixture<RecordedCall>(fixturesDir, name);

const allRecordings = () => fixtureNames(fixturesDir).map(loadMangaBakaRecording);

/** A client answered by every MangaBaka recording. `fetch.requests` lists what it asked. */
export function replayedMangaBaka() {
  const fetch = replayAt(mangabakaUrl, allRecordings());
  return { fetch, mangabaka: createMangaBakaClient({ fetch }) };
}

/** IDs in the recordings. */
export const recorded = { berserk: 1692, blueLock: 83, missing: 2147483000 };
