// A bencode writer for building .torrent files in tests, and a reader for the recorders.

export type Value = number | string | Uint8Array | Value[] | { [key: string]: Value };

/** Byte strings come back as Uint8Array; dictionary keys as latin1 strings. */
export function bdecode(bytes: Uint8Array): Value {
  let at = 0;
  const read = (): Value => {
    const byte = bytes[at];
    if (byte === 0x69) {
      const end = bytes.indexOf(0x65, at);
      const n = Number(Buffer.from(bytes.subarray(at + 1, end)).toString("latin1"));
      at = end + 1;
      return n;
    }
    if (byte === 0x6c) {
      at++;
      const list: Value[] = [];
      while (bytes[at] !== 0x65) list.push(read());
      at++;
      return list;
    }
    if (byte === 0x64) {
      at++;
      const dict: Record<string, Value> = {};
      while (bytes[at] !== 0x65) {
        const key = Buffer.from(read() as Uint8Array).toString("latin1");
        dict[key] = read();
      }
      at++;
      return dict;
    }
    const colon = bytes.indexOf(0x3a, at);
    if (colon < 0) throw new Error("Not bencode");
    const length = Number(Buffer.from(bytes.subarray(at, colon)).toString("latin1"));
    at = colon + 1 + length;
    return bytes.slice(colon + 1, at);
  };
  return read();
}

const text = (s: string) => new TextEncoder().encode(s);

export function bencode(value: Value): Uint8Array {
  const parts: Uint8Array[] = [];
  const write = (v: Value): void => {
    if (typeof v === "number") parts.push(text(`i${v}e`));
    else if (typeof v === "string") write(text(v));
    else if (v instanceof Uint8Array) parts.push(text(`${v.length}:`), v);
    else if (Array.isArray(v)) {
      parts.push(text("l"));
      v.forEach(write);
      parts.push(text("e"));
    } else {
      parts.push(text("d"));
      // Keys sorted by bytes, as the format requires.
      for (const key of Object.keys(v).sort()) {
        write(key);
        write(v[key]!);
      }
      parts.push(text("e"));
    }
  };
  write(value);
  return Buffer.concat(parts);
}

/** A small single-file v1 torrent, and its info dictionary. */
export function sampleTorrent(name = "Berserk v42.cbz", extra: Record<string, Value> = {}) {
  const info = { name, length: 1234, "piece length": 16384, pieces: new Uint8Array(20).fill(7), ...extra };
  return { info, bytes: bencode({ announce: "https://tracker.example/announce", "creation date": 1, info }) };
}
