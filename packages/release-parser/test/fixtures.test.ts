import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { type ParsedRelease, parseRelease } from "../src";

interface FixtureFile {
  source: string;
  synthetic: boolean;
  cases: { input: string; expected: Partial<Omit<ParsedRelease, "volumes">> & { volumes?: number[] | string } }[];
}

const fixturesDir = new URL("../fixtures/", import.meta.url);

/** "1-19" → [1..19]; arrays pass through. Keeps fixture files short. */
function expandVolumes(v: number[] | string): number[] {
  if (Array.isArray(v)) return v;
  const [from, to] = v.split("-").map(Number);
  const out: number[] = [];
  for (let n = from!; n <= to!; n++) out.push(n);
  return out;
}

for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))) {
  const fixture = JSON.parse(readFileSync(new URL(file, fixturesDir), "utf8")) as FixtureFile;

  describe(file, () => {
    it.each(fixture.cases)("$input", ({ input, expected }) => {
      const { volumes, ...rest } = expected;
      const want: Partial<ParsedRelease> = { ...rest };
      if (volumes !== undefined) want.volumes = expandVolumes(volumes);
      expect(parseRelease(input)).toMatchObject(want);
    });
  });
}
