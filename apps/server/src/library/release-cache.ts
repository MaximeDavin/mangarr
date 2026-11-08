// The latest search results of each series, kept in memory so Grab can find a release by guid
// (spec §7.3). The UI never sees Prowlarr's download links: they hold its API key.

import type { SearchResult } from "./search";

/** Long enough to read the results and decide; a stale link may no longer work. */
export const releaseCacheTtlMs = 30 * 60 * 1000;

export class ReleaseCache {
  readonly #entries = new Map<number, { expiresAt: number; byGuid: Map<string, SearchResult> }>();

  constructor(
    private readonly ttlMs = releaseCacheTtlMs,
    private readonly now: () => number = Date.now,
  ) {}

  /** Replaces the series' previous results. */
  set(seriesId: number, results: readonly SearchResult[]): void {
    this.#prune();
    this.#entries.set(seriesId, {
      expiresAt: this.now() + this.ttlMs,
      byGuid: new Map(results.map((result) => [result.release.guid, result])),
    });
  }

  get(seriesId: number, guid: string): SearchResult | undefined {
    const entry = this.#entries.get(seriesId);
    if (!entry || entry.expiresAt <= this.now()) return undefined;
    return entry.byGuid.get(guid);
  }

  #prune(): void {
    const now = this.now();
    for (const [seriesId, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(seriesId);
  }
}
