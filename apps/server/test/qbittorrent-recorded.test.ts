// The qBittorrent client against calls recorded from a real qBittorrent (scripts/record-qbittorrent.ts),
// one recording per scenario in qbittorrent-scenarios.ts. Each replay must send the recorded calls
// (replay only answers those) and get the outcome recorded: a change in how the client reads
// qBittorrent shows up as a diff. qbittorrent.test.ts covers the edge cases with a fake.

import { describe, expect, it } from "bun:test";
import { createQBittorrentClient } from "../src/integrations/qbittorrent";
import {
  asStored,
  loadQBittorrentRecording,
  type QBittorrentRecording,
  recordedQBittorrentScenarios,
  scenarios,
} from "./qbittorrent-scenarios";
import { recordedServices, replayRun } from "./run-replay";

const recorded = recordedQBittorrentScenarios();

async function replay(recording: QBittorrentRecording, name: string) {
  const fetch = replayRun(recording);
  const client = createQBittorrentClient({
    url: recordedServices.qbittorrent,
    username: "REDACTED",
    password: "REDACTED",
    fetch,
  });
  const outcome = asStored(await scenarios[name]!.run(client, recording.context));
  return { outcome, fetch };
}

it("has a recording for every scenario", () => {
  expect(recorded.sort()).toEqual(Object.keys(scenarios).sort());
});

describe.each(recorded)("%s", (name) => {
  const recording = loadQBittorrentRecording(name);

  it("sends the recorded calls and gets the recorded outcome", async () => {
    const { outcome, fetch } = await replay(recording, name);
    expect(outcome).toEqual(recording.outcome);
    expect(fetch.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(
      recording.calls.map((c) => `${c.request.method} ${c.request.path}`),
    );
  });
});

describe("what qBittorrent does", () => {
  // Facts the client relies on, as the recorded version showed them (spec §6.2).
  const outcomeOf = (name: string) => loadQBittorrentRecording(name).outcome as Record<string, unknown>;

  it("answers a login with a session cookie", () => {
    const login = loadQBittorrentRecording("login-and-version").calls[0]!;
    expect(login.request.path).toBe("/api/v2/auth/login");
    expect(login.response.status).toBeLessThan(300);
    expect(login.response.setCookie?.[0]).toMatch(/^(SID|QBT_SID_\d+)=redacted$/);
  });

  it("answers a wrong password with 401, reported as unauthorized", () => {
    expect(outcomeOf("wrong-password")).toMatchObject({ error: { kind: "unauthorized", status: 401 } });
  });

  it("creates a missing category, and leaves an existing one alone", () => {
    const { calls } = loadQBittorrentRecording("categories");
    expect(calls.filter((c) => c.request.path.endsWith("/createCategory"))).toHaveLength(1);
    expect(outcomeOf("categories")).toEqual({ existing: {}, created: {} });
  });

  it("lists a torrent by hash with the fields the poller reads, and nothing for an unknown hash", () => {
    const { known, unknown, files, filesUnknown } = outcomeOf("torrents") as Record<
      string,
      { ok?: unknown[]; error?: unknown }
    >;
    const [torrent] = known!.ok as {
      hash: string;
      state: string;
      progress: number;
      amountLeft: number;
      savePath: string;
    }[];
    expect(torrent!.hash).toBe(loadQBittorrentRecording("torrents").context.knownHash);
    expect(torrent!.state).toBeString();
    expect(torrent!.progress).toBeNumber();
    expect(torrent!.amountLeft).toBeNumber();
    expect(torrent!.savePath).toStartWith("/");
    expect(unknown!.ok).toEqual([]);
    expect((files!.ok as { name: string }[]).length).toBeGreaterThan(0);
    // The file list of an unknown hash is a 404, not an empty list.
    expect(filesUnknown).toMatchObject({ error: { kind: "http", status: 404 } });
  });

  it("refuses to add a torrent it already has", () => {
    expect(outcomeOf("add-duplicate")).toEqual({
      error: { kind: "http", status: 409, message: "qBittorrent already has this torrent" },
    });
  });
});
