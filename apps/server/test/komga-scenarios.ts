// What scripts/record-komga.ts does against a real Komga, one recording per scenario, and what
// test/komga-recorded.test.ts does again against each recording. Each scenario returns what the
// client got (values, or errors as { kind, status, message }), and the test checks the replay gets
// the same.

import { join } from "node:path";
import { type KomgaClient, KomgaError } from "../src/integrations/komga";
import { fixtureNames, loadFixture } from "./fixtures";

export const komgaFixturesDir = join(import.meta.dir, "fixtures/komga");

/** The address recordings use in place of the real one. */
export const recordedKomgaUrl = "http://komga:25600";

/** A library id no Komga has. */
export const unknownLibraryId = "0MANGARRNOLIBRARY";

export interface KomgaScenarioContext {
  /** A library the recorded Komga has. */
  libraryId: string;
}

export interface KomgaCall {
  request: { method: string; path: string; query: [string, string][] };
  response: { status: number; contentType: string | null; body?: unknown };
}

export interface KomgaRecording {
  description: string;
  recordedAt: string;
  komgaVersion?: string;
  context: KomgaScenarioContext;
  /** What the client got. */
  outcome: unknown;
  calls: KomgaCall[];
}

type Outcome<T> = { ok: T } | { error: { kind: string; status?: number; message: string } };

async function outcome<T>(call: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await call };
  } catch (error) {
    if (!(error instanceof KomgaError)) throw error;
    return { error: { kind: error.kind, status: error.status, message: error.message } };
  }
}

/** As it is stored: JSON drops undefined fields. */
export const asStored = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

export interface KomgaScenario {
  description: string;
  /** Call with a wrong API key. */
  wrongKey?: boolean;
  run(client: KomgaClient, context: KomgaScenarioContext): Promise<unknown>;
}

export const komgaScenarios: Record<string, KomgaScenario> = {
  libraries: {
    description: "List the libraries and read the key's user (the connection test and the Language picker)",
    run: async (client) => ({
      libraries: await outcome(client.libraries()),
      me: await outcome(client.me()),
    }),
  },
  library: {
    description: "Get a library Komga has, then one it doesn't (the check when a Language is saved)",
    run: async (client, { libraryId }) => ({
      known: await outcome(client.library(libraryId)),
      unknown: await outcome(client.library(unknownLibraryId)),
    }),
  },
  scan: {
    description: "Ask for a scan of a library Komga has, then of one it doesn't",
    run: async (client, { libraryId }) => ({
      known: await outcome(client.scanLibrary(libraryId)),
      unknown: await outcome(client.scanLibrary(unknownLibraryId)),
    }),
  },
  "wrong-key": {
    description: "List the libraries and ask for a scan with a wrong API key",
    wrongKey: true,
    run: async (client, { libraryId }) => ({
      libraries: await outcome(client.libraries()),
      scan: await outcome(client.scanLibrary(libraryId)),
    }),
  },
};

export const loadKomgaRecording = (name: string) => loadFixture<KomgaRecording>(komgaFixturesDir, name);

export const recordedKomgaScenarios = () => fixtureNames(komgaFixturesDir);

/**
 * A fetch that answers each request with the next recorded call, which must be for the same
 * method and path: a client that asks for something else, or more, fails the test.
 */
export function replayKomga(calls: KomgaCall[]) {
  const requests: Request[] = [];
  let next = 0;
  const fetch = async (request: Request) => {
    requests.push(request);
    const url = new URL(request.url);
    const call = calls[next++];
    if (
      !call ||
      call.request.method !== request.method ||
      `${recordedKomgaUrl}${call.request.path}` !== `${url.origin}${url.pathname}`
    ) {
      throw new Error(`No recording for ${request.method} ${url.pathname} (call ${next})`);
    }
    const { status, contentType, body } = call.response;
    const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 || status === 202 ? text || null : text, {
      status,
      headers: contentType ? { "content-type": contentType } : {},
    });
  };
  return Object.assign(fetch, { requests });
}
