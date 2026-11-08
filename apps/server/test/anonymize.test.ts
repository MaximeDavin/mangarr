import { describe, expect, it } from "bun:test";
import { anonymizeTorrent, realsIn, remapHashes, trackerAliases } from "../scripts/anonymize";
import { torrentInfoHash } from "../src/integrations/torrent";
import { bdecode, sampleTorrent } from "./bencode";

const indexers = [
  { id: 1, name: "Nyaa.si", definitionName: "nyaasi", privacy: "public", indexerUrls: ["https://nyaa.si/"] },
  {
    id: 2,
    name: "SecretBay",
    definitionName: "secretbay",
    privacy: "private",
    indexerUrls: ["https://www.secretbay.org/"],
  },
];

describe("trackerAliases", () => {
  const aliases = trackerAliases(indexers);

  it("replaces private indexers' names, slugs and hosts, and leaves public ones", () => {
    expect(aliases.scrub("Search on SecretBay: https://www.secretbay.org/t/1#secretbay, also Nyaa.si")).toBe(
      "Search on Private Tracker 2: https://private-tracker-2.invalid/t/1#private-tracker-2, also Nyaa.si",
    );
  });

  it("finds real names left in any case", () => {
    expect(realsIn("by SECRETBAY", aliases.reals)).toEqual(["SecretBay", "secretbay"]);
    expect(realsIn(aliases.scrub("SecretBay secretbay.org"), aliases.reals)).toEqual([]);
  });
});

describe("anonymizeTorrent", () => {
  it("drops the source tag, replaces the pieces, and gives the hash of the new file", () => {
    const { bytes } = sampleTorrent("Berserk v42.cbz", { private: 1, source: "SecretBay" });
    const out = anonymizeTorrent(bytes, new Uint8Array(32));
    const info = (bdecode(out.bytes) as Record<string, Record<string, unknown>>).info!;
    expect(Object.keys(info).sort()).toEqual(["length", "name", "piece length", "pieces", "private"]);
    expect(info.pieces).not.toEqual(new Uint8Array(20).fill(7));
    expect(out.realHash).toBe(torrentInfoHash(bytes));
    expect(out.fakeHash).toBe(torrentInfoHash(out.bytes));
    expect(out.fakeHash).not.toBe(out.realHash);
    expect(Buffer.from(out.bytes).toString("latin1")).not.toContain("SecretBay");
  });
});

describe("remapHashes", () => {
  it("replaces a hash in any case, everywhere", () => {
    const real = "ab".repeat(20);
    const fake = "cd".repeat(20);
    expect(remapHashes({ hash: real, list: [`hashes=${real.toUpperCase()}`] }, new Map([[real, fake]]))).toEqual({
      hash: fake,
      list: [`hashes=${fake}`],
    });
  });
});
