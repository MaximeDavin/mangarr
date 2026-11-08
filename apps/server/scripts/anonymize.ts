// Shared by the recorders: hides which private trackers a recording came from, and which of their
// torrents were downloaded. Secrets (keys, passwords, passkeys) are handled by each recorder; this
// is about not tying a public recording to a tracker account.
//
// - Private and semi-private indexers get a stand-in name ("Private Tracker 2"), slug and host.
// - A private .torrent keeps only what mangarr reads (name, sizes, files), with its piece hashes
//   replaced, so its info-hash can't be recomputed from the real torrent.
// - Recordings carry the day they were made, not the time.

import { createHmac } from "node:crypto";
import { torrentInfoHash } from "../src/integrations/torrent";
import { bdecode, bencode, type Value } from "../test/bencode";

export interface IndexerInfo {
  id: number;
  name: string;
  definitionName?: string;
  privacy?: string;
  indexerUrls?: string[];
}

/** Definition names shared by many indexers: not a tracker's name. */
const genericDefinitions = new Set(["cardigann", "torznab", "newznab"]);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface TrackerAliases {
  /** The text with every private indexer's name, slug and host replaced. */
  scrub(text: string): string;
  /** The real names and hosts, to check (ignoring case) that none is left. */
  reals: string[];
}

export function trackerAliases(indexers: readonly IndexerInfo[]): TrackerAliases {
  const replacements: [RegExp, string][] = [];
  const reals: string[] = [];
  for (const indexer of indexers) {
    if (indexer.privacy === undefined || indexer.privacy === "public") continue;
    const slug = `private-tracker-${indexer.id}`;
    for (const raw of indexer.indexerUrls ?? []) {
      let host: string;
      try {
        host = new URL(raw).host.replace(/^www\./, "");
      } catch {
        continue;
      }
      replacements.push([new RegExp(`(www\\.)?${escapeRegExp(host)}`, "gi"), `${slug}.invalid`]);
      reals.push(host);
    }
    if (indexer.name.length >= 3) {
      // Exact case first, so the display name reads as a name and lowercase uses read as a slug.
      replacements.push([new RegExp(escapeRegExp(indexer.name), "g"), `Private Tracker ${indexer.id}`]);
      replacements.push([new RegExp(escapeRegExp(indexer.name), "gi"), slug]);
      reals.push(indexer.name);
    }
    const definition = indexer.definitionName;
    if (definition && definition.length >= 3 && !genericDefinitions.has(definition.toLowerCase())) {
      replacements.push([new RegExp(escapeRegExp(definition), "gi"), slug]);
      reals.push(definition);
    }
  }
  return {
    scrub: (text) => replacements.reduce((out, [pattern, to]) => out.replace(pattern, to), text),
    reals,
  };
}

/** The real names left in `text`, ignoring case. */
export function realsIn(text: string, reals: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return reals.filter((real) => lower.includes(real.toLowerCase()));
}

/** Keys of a v1 `info` dictionary that mangarr reads. Everything else (source tag, v2 file tree…) goes. */
const infoKeys = ["name", "length", "piece length", "pieces", "files", "private"];

/**
 * A .torrent with one placeholder tracker and an `info` dictionary that can't be traced back:
 * unknown keys dropped and piece hashes replaced by HMAC bytes. Returns the new file and both hashes.
 */
export function anonymizeTorrent(bytes: Uint8Array, key: Uint8Array) {
  const torrent = bdecode(bytes) as Record<string, Value>;
  const info = torrent.info as Record<string, Value>;
  const kept: Record<string, Value> = {};
  for (const name of infoKeys) if (info[name] !== undefined) kept[name] = info[name];
  if (kept.files) {
    kept.files = (kept.files as Record<string, Value>[]).map(({ length, path }) => ({ length: length!, path: path! }));
  }
  const pieces = info.pieces as Uint8Array;
  const fake = new Uint8Array(pieces.length);
  for (let i = 0; i < pieces.length; i += 32) {
    fake.set(
      createHmac("sha256", key)
        .update(String(i))
        .update(pieces.subarray(i, i + 32))
        .digest()
        .subarray(0, Math.min(32, pieces.length - i)),
      i,
    );
  }
  kept.pieces = fake;
  const out = bencode({ announce: "https://tracker.invalid/announce", info: kept });
  return { bytes: out, realHash: torrentInfoHash(bytes), fakeHash: torrentInfoHash(out) };
}

/** A stand-in info-hash for a private torrent that isn't in the recording itself. */
export const fakeHash = (hash: string, key: Uint8Array) =>
  createHmac("sha256", key).update(hash.toLowerCase()).digest("hex").slice(0, 40);

/** `value` with every real info-hash (any case) replaced by its stand-in. */
export function remapHashes<T>(value: T, hashes: ReadonlyMap<string, string>): T {
  if (hashes.size === 0) return value;
  let json = JSON.stringify(value);
  for (const [real, fake] of hashes) json = json.replace(new RegExp(real, "gi"), fake);
  return JSON.parse(json) as T;
}

/** When a recording was made: the day only. */
export const recordedOn = () => new Date().toISOString().slice(0, 10);
