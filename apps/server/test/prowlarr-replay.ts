// Replays Prowlarr calls recorded by scripts/record-prowlarr.ts (test/fixtures/prowlarr/*.json).

import { join } from "node:path";
import { fixtureNames, loadFixture } from "./fixtures";
import { type RecordedCall, replayAt } from "./replay";

export interface Recording extends RecordedCall {
  prowlarrVersion: string;
}

export const fixturesDir = join(import.meta.dir, "fixtures/prowlarr");

/** The URL and API key the recordings use in place of the real ones. */
export const recordedUrl = "http://prowlarr:9696";
export const recordedApiKey = "0123456789abcdef0123456789abcdef";

export const loadRecording = (name: string) => loadFixture<Recording>(fixturesDir, name);

/** Names of the recorded searches, e.g. `search-nyaa-si-one-piece`. */
export const recordedSearches = () => fixtureNames(fixturesDir).filter((name) => name.startsWith("search-"));

/** See `replayAt`. */
export const replay = (...recordings: Recording[]) => replayAt(recordedUrl, recordings);
