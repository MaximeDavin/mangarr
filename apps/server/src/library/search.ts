// Interactive search (spec §7.2): query Prowlarr with each search term, then dedupe, parse,
// annotate and sort the results for one series.

import { type MatchTarget, type ParsedRelease, parseRelease, titleMatch } from "@mangarr/release-parser";
import type { ProwlarrClient, ProwlarrRelease } from "../integrations/prowlarr";

export type SearchMatch = "exact" | "partial" | "none";

export interface SearchResult {
  release: ProwlarrRelease;
  parsed: ParsedRelease;
  match: SearchMatch;
  /** Volumes in the release that the series doesn't own. */
  newVolumes: number[];
  /**
   * The release brings at least one volume the series doesn't own. A complete pack with no
   * numbers counts when the series has missing volumes or an unknown volume count.
   */
  coversMissing: boolean;
}

export interface SearchSeries {
  /** Terms of kind `search`, sent to Prowlarr one query each. */
  queries: readonly string[];
  /** Search terms and aliases, for title matching. */
  names: readonly string[];
  authors: readonly string[];
  /** Owned volume numbers. */
  owned: readonly number[];
  volumeCount: number | null;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** Results Prowlarr returned across every query, before duplicates were removed. */
  received: number;
  /** Chapter releases dropped (§7.2 step 3). */
  chapterReleases: number;
  /** Usenet releases dropped: mangarr only sends torrents to qBittorrent. */
  usenetReleases: number;
}

const matchRank: Record<SearchMatch, number> = { exact: 2, partial: 1, none: 0 };

/** Same torrent from several indexers or queries: by info-hash, falling back to guid. */
const dedupeKey = (release: ProwlarrRelease) => release.infoHash ?? `guid:${release.guid}`;

/** The order of §7.2 step 5, then newest first and by title so the order is stable. */
function compare(a: SearchResult, b: SearchResult): number {
  return (
    matchRank[b.match] - matchRank[a.match] ||
    Number(b.coversMissing) - Number(a.coversMissing) ||
    (b.release.seeders ?? -1) - (a.release.seeders ?? -1) ||
    (b.release.publishDate ?? 0) - (a.release.publishDate ?? 0) ||
    a.release.title.localeCompare(b.release.title)
  );
}

/** Everything after the Prowlarr calls. No I/O. */
export function rankReleases(
  releases: readonly ProwlarrRelease[],
  series: Omit<SearchSeries, "queries">,
): SearchOutcome {
  const unique = new Map<string, ProwlarrRelease>();
  let usenetReleases = 0;
  for (const release of releases) {
    if (release.protocol === "usenet") {
      usenetReleases++;
      continue;
    }
    const key = dedupeKey(release);
    const seen = unique.get(key);
    // Keep the copy with the most seeders.
    if (!seen || (release.seeders ?? -1) > (seen.seeders ?? -1)) unique.set(key, release);
  }

  const target: MatchTarget = { names: series.names, authors: series.authors };
  const owned = new Set(series.owned);
  const hasMissing =
    series.volumeCount === null ||
    Array.from({ length: series.volumeCount }, (_, i) => i + 1).some((n) => !owned.has(n));

  const results: SearchResult[] = [];
  let chapterReleases = 0;
  for (const release of unique.values()) {
    const parsed = parseRelease(release.title);
    if (parsed.isChapterRelease) {
      chapterReleases++;
      continue;
    }
    const newVolumes = parsed.volumes.filter((n) => !owned.has(n));
    results.push({
      release,
      parsed,
      match: titleMatch(parsed, target) ?? "none",
      newVolumes,
      coversMissing: newVolumes.length > 0 || (parsed.volumes.length === 0 && parsed.isComplete && hasMissing),
    });
  }

  return { results: results.sort(compare), received: releases.length, chapterReleases, usenetReleases };
}

/** One Prowlarr query per search term, all at once, then `rankReleases`. */
export async function searchReleases(
  prowlarr: ProwlarrClient,
  series: SearchSeries,
  language: { prowlarrIndexerIds: readonly number[]; prowlarrCategories: readonly number[] },
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const lists = await Promise.all(
    series.queries.map((query) =>
      prowlarr.search({
        query,
        indexerIds: language.prowlarrIndexerIds,
        categories: language.prowlarrCategories,
        signal,
      }),
    ),
  );
  return rankReleases(lists.flat(), series);
}
