// Recorded fixtures: one JSON file per recording, in a folder per service (test/fixtures/*/).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The recordings in `dir`, by name (the file name without `.json`). None when `dir` doesn't exist. */
export function fixtureNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length));
  } catch {
    return [];
  }
}

export function loadFixture<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as T;
}

/** Writes one recording; returns its path. */
export function writeFixture(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** Replaces every recording in `dir` with `recordings`. */
export function replaceFixtures(dir: string, recordings: ReadonlyMap<string, unknown>): void {
  for (const name of fixtureNames(dir)) rmSync(join(dir, `${name}.json`));
  for (const [name, value] of recordings) writeFixture(dir, name, value);
}
