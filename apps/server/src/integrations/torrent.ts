// Info-hashes from magnet links and .torrent files (spec §7.3). v1 only: the SHA-1 of the bencoded
// `info` dictionary. Hybrid v1+v2 torrents have one; v2-only torrents are not supported in v0.

import { createHash } from "node:crypto";

/** What a release's download link leads to, and what qBittorrent is given. */
export type TorrentSource = { kind: "magnet"; uri: string } | { kind: "torrent"; bytes: Uint8Array<ArrayBuffer> };

export class TorrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TorrentError";
  }
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * A v1 info-hash as lowercase hex. Accepts 40 hex characters or the 32-character
 * base32 form some magnets use. Anything else (including v2 hashes) gives undefined.
 */
export function normalizeInfoHash(value: string | null | undefined): string | undefined {
  const hash = value?.trim();
  if (!hash) return undefined;
  if (/^[0-9a-f]{40}$/i.test(hash)) return hash.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(hash)) {
    let bits = "";
    for (const char of hash.toUpperCase()) bits += base32Alphabet.indexOf(char).toString(2).padStart(5, "0");
    let hex = "";
    for (let i = 0; i < bits.length; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }
  return undefined;
}

const D = 0x64; // d
const L = 0x6c; // l
const I = 0x69; // i
const E = 0x65; // e
const COLON = 0x3a;
const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;

type Range = { start: number; end: number };

const invalid = () => new TorrentError("Not a valid .torrent file");

/** A byte string at `at`: its content's [start, end), and where the next value starts. */
function readString(bytes: Uint8Array, at: number): Range {
  let colon = at;
  while (isDigit(bytes[colon])) colon++;
  if (colon === at || bytes[colon] !== COLON) throw invalid();
  const length = Number(new TextDecoder().decode(bytes.subarray(at, colon)));
  const start = colon + 1;
  const end = start + length;
  if (end > bytes.length) throw invalid();
  return { start, end };
}

/** Where the value starting at `at` ends (exclusive). `onString` sees every byte string in it (not dictionary keys). */
function skipValue(bytes: Uint8Array, at: number, onString?: (range: Range) => void, depth = 0): number {
  if (depth > 64) throw invalid();
  const byte = bytes[at];
  if (byte === I) {
    const end = bytes.indexOf(E, at + 1);
    if (end < 0) throw invalid();
    return end + 1;
  }
  if (byte === L || byte === D) {
    let next = at + 1;
    while (bytes[next] !== E) {
      if (next >= bytes.length) throw invalid();
      if (byte === D) next = readString(bytes, next).end;
      next = skipValue(bytes, next, onString, depth + 1);
    }
    return next + 1;
  }
  if (isDigit(byte)) {
    const string = readString(bytes, at);
    onString?.(string);
    return string.end;
  }
  throw invalid();
}

/** The keys of the dictionary at `at`, each with its value's [start, end). */
function dictEntries(bytes: Uint8Array, at: number): Map<string, Range> {
  if (bytes[at] !== D) throw invalid();
  const entries = new Map<string, Range>();
  let next = at + 1;
  while (bytes[next] !== E) {
    if (next >= bytes.length) throw invalid();
    const key = readString(bytes, next);
    const start = key.end;
    const end = skipValue(bytes, start);
    entries.set(new TextDecoder().decode(bytes.subarray(key.start, key.end)), { start, end });
    next = end;
  }
  return entries;
}

/** The bencoded `info` dictionary, byte for byte as stored: what the info-hash is computed over. */
export function infoDictionary(bytes: Uint8Array): Uint8Array {
  const info = dictEntries(bytes, 0).get("info");
  if (!info || bytes[info.start] !== D) throw invalid();
  return bytes.subarray(info.start, info.end);
}

/** Every byte string outside the `info` dictionary (trackers, comment, web seeds…), as UTF-8. */
export function stringsOutsideInfo(bytes: Uint8Array): string[] {
  const strings: string[] = [];
  const decoder = new TextDecoder();
  for (const [key, value] of dictEntries(bytes, 0)) {
    if (key !== "info")
      skipValue(bytes, value.start, ({ start, end }) => strings.push(decoder.decode(bytes.subarray(start, end))));
  }
  return strings;
}

/** The v1 info-hash of a .torrent file, as lowercase hex. */
export function torrentInfoHash(bytes: Uint8Array): string {
  const info = dictEntries(bytes, 0).get("info");
  if (!info) throw invalid();
  const keys = dictEntries(bytes, info.start);
  if (!keys.has("pieces")) {
    if (keys.has("meta version")) throw new TorrentError("v2-only torrents are not supported");
    throw invalid();
  }
  return createHash("sha1").update(bytes.subarray(info.start, info.end)).digest("hex");
}

/** The v1 info-hash in a magnet link (`xt=urn:btih:`), as lowercase hex. */
export function magnetInfoHash(uri: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(uri).searchParams;
  } catch {
    throw new TorrentError("Not a valid magnet link");
  }
  const topics = params.getAll("xt");
  for (const topic of topics) {
    const match = /^urn:btih:(.+)$/i.exec(topic);
    const hash = match && normalizeInfoHash(match[1]);
    if (hash) return hash;
  }
  if (topics.some((t) => /^urn:btmh:/i.test(t))) throw new TorrentError("v2-only magnet links are not supported");
  throw new TorrentError("The magnet link has no info-hash");
}

/** The v1 info-hash of a magnet link or .torrent file, as lowercase hex. */
export const infoHashOf = (source: TorrentSource): string =>
  source.kind === "magnet" ? magnetInfoHash(source.uri) : torrentInfoHash(source.bytes);
