// Info-hashes from .torrent files and magnet links (spec §7.3).

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { magnetInfoHash, stringsOutsideInfo, TorrentError, torrentInfoHash } from "../src/integrations/torrent";
import { bencode, sampleTorrent } from "./bencode";

const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

describe("torrentInfoHash", () => {
  it("is the SHA-1 of the bencoded info dictionary, as stored in the file", () => {
    const { info, bytes } = sampleTorrent();
    expect(torrentInfoHash(bytes)).toBe(sha1(bencode(info)));
  });

  it("handles nested lists and dictionaries around and inside info", () => {
    const info = {
      name: "Berserk",
      "piece length": 16384,
      pieces: new Uint8Array(40),
      files: [
        { length: 1, path: ["v01.cbz"] },
        { length: 2, path: ["sub", "v02.cbz"] },
      ],
    };
    const bytes = bencode({ "announce-list": [["a"], ["b"]], info, "url-list": ["x"] });
    expect(torrentInfoHash(bytes)).toBe(sha1(bencode(info)));
  });

  it("uses the v1 hash of a hybrid torrent", () => {
    const { info, bytes } = sampleTorrent("hybrid", { "meta version": 2, "file tree": {} });
    expect(torrentInfoHash(bytes)).toBe(sha1(bencode(info)));
  });

  it("rejects v2-only torrents", () => {
    const bytes = bencode({ info: { name: "v2", "piece length": 16384, "meta version": 2, "file tree": {} } });
    expect(() => torrentInfoHash(bytes)).toThrow("v2-only torrents are not supported");
  });

  it("rejects anything that isn't a torrent", () => {
    for (const bytes of [
      new TextEncoder().encode("<html>login</html>"),
      bencode({ announce: "x" }),
      sampleTorrent().bytes.subarray(0, 60),
      new Uint8Array(),
    ]) {
      expect(() => torrentInfoHash(bytes)).toThrow(TorrentError);
    }
  });
});

describe("stringsOutsideInfo", () => {
  it("finds every tracker, nested or not, and nothing from info", () => {
    const { info } = sampleTorrent("secret-name.cbz");
    const bytes = bencode({
      announce: "https://t.example/abc/announce",
      "announce-list": [["https://a.example/announce"], ["udp://b.example:80"]],
      "creation date": 1,
      info,
      "url-list": ["https://seed.example/x"],
    });
    expect(stringsOutsideInfo(bytes)).toEqual([
      "https://t.example/abc/announce",
      "https://a.example/announce",
      "udp://b.example:80",
      "https://seed.example/x",
    ]);
  });
});

describe("magnetInfoHash", () => {
  const hex = "8247b1178fd004b08457ef62e851e12b1c85eba3";

  it("reads hex and base32 hashes, encoded or not", () => {
    expect(magnetInfoHash(`magnet:?xt=urn%3Abtih%3A${hex.toUpperCase()}&dn=Berserk`)).toBe(hex);
    expect(magnetInfoHash(`magnet:?dn=x&xt=urn:btih:${hex}`)).toBe(hex);
    // The same hash in base32.
    expect(magnetInfoHash("magnet:?xt=urn:btih:QJD3CF4P2ACLBBCX55ROQUPBFMOIL25D")).toBe(hex);
  });

  it("rejects v2-only and hashless links", () => {
    expect(() => magnetInfoHash(`magnet:?xt=urn:btmh:1220${"a".repeat(64)}`)).toThrow("v2-only");
    expect(() => magnetInfoHash("magnet:?dn=nothing")).toThrow("no info-hash");
  });
});
