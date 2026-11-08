// The Komga client against calls recorded from a real Komga (scripts/record-komga.ts), one
// recording per scenario in komga-scenarios.ts. Each replay must send the recorded calls and get
// the recorded outcome. komga.test.ts covers the edge cases with a fake.

import { describe, expect, it } from "bun:test";
import { createKomgaClient } from "../src/integrations/komga";
import {
  asStored,
  type KomgaRecording,
  komgaScenarios,
  loadKomgaRecording,
  recordedKomgaScenarios,
  recordedKomgaUrl,
  replayKomga,
} from "./komga-scenarios";

const recorded = recordedKomgaScenarios();

async function replay(recording: KomgaRecording, name: string) {
  const fetch = replayKomga(recording.calls);
  const client = createKomgaClient({ url: recordedKomgaUrl, apiKey: "REDACTED", fetch });
  const outcome = asStored(await komgaScenarios[name]!.run(client, recording.context));
  return { outcome, fetch };
}

it("has a recording for every scenario", () => {
  expect(recorded.sort()).toEqual(Object.keys(komgaScenarios).sort());
});

describe.each(recorded)("%s", (name) => {
  const recording = loadKomgaRecording(name);

  it("sends the recorded calls and gets the recorded outcome", async () => {
    const { outcome, fetch } = await replay(recording, name);
    expect(outcome).toEqual(recording.outcome);
    expect(fetch.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(
      recording.calls.map((c) => `${c.request.method} ${c.request.path}`),
    );
  });
});
