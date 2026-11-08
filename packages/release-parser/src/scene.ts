import type { ReleaseSource } from "./types";
import { addRange, indexOf, isYear, sorted, token, word, YEAR } from "./util";

// Scene names only ("One.Piece.T01.FRENCH.CBZ.eBook-GRP"): where the title stops when no volume marker comes first.
const STOP_RE = token(
  `${YEAR}|french|fran[cç]ais|fr|english|vf|multi|scans?|retail|manga|cbz|cbr|pdf|epub|ebook|officiel|digital|web|hybrid|PalaceMultiUnivers|BD(?: HD)? PACK`,
);
const YEAR_RE = token(YEAR, "u");
const INT_RE = word("Int", "u"); // "Akira.Int.T1-14"
// Numbers with no volume keyword: "1-5", "1 a 28", "113&114", "1 et 2", "01".
const BARE_VOLUME_RE = /(?<![\p{L}\d.&-])(\d{1,3})(?:\s*(?:-|&)\s*|\s+(?:a|à|et)\s+)?(\d{1,3})?(?![\p{L}\d&])/gu;

// Group then volume marker at the end of a scene name: "danke-Empire-T01-T40".
const TRAILING_MARKER_RE = /^(.+?)-([TtVv]\d+(?:\.\d+)?(?:-[TtVv]?\d+(?:\.\d+)?)?)$/;

const HYBRID_RE = word("hybrid");
const SCAN_RE = word("scans?");
const RETAIL_RE = word("retail|digital|officiel|web");

/**
 * Undo scene-style naming ("One.Piece.T01.FRENCH.CBZ.eBook-GRP").
 * The group is what follows the first "-" of the last dot segment, so "CBZ-NEO RIP-Club" gives "NEO RIP-Club".
 */
export function unscene(text: string): { text: string; group?: string; isScene: boolean } {
  const lastDot = text.lastIndexOf(".");
  const dash = text.indexOf("-", lastDot + 1);
  const base = dash > lastDot && lastDot >= 0 ? text.slice(0, dash) : text;
  if (/\s/.test(base) || !/[._]/.test(base)) return { text: text.replace(/_/g, " "), isScene: false };

  let group: string | undefined;
  if (base !== text) {
    const candidate = text.slice(dash + 1).trim();
    if (candidate && !/^[vt]?\d/i.test(candidate)) {
      // "…Digital-danke-Empire-T01-T40": a volume marker after the group goes back into the name.
      const trailing = candidate.match(TRAILING_MARKER_RE);
      group = trailing ? trailing[1]! : candidate;
      text = trailing ? `${base}.${trailing[2]!}` : base;
    }
  }
  // "The-Fragrant-Flower-Blooms-with-Dignity-T.10…": hyphens used as word separators in the first segment.
  const firstSegmentEnd = text.indexOf(".");
  const firstSegment = firstSegmentEnd >= 0 ? text.slice(0, firstSegmentEnd) : text;
  if ((firstSegment.match(/-/g) ?? []).length >= 3) {
    text = firstSegment.replace(/-/g, " ") + text.slice(firstSegment.length);
  }
  text = text
    .replace(/_/g, " ")
    .replace(/(?<![\p{L}\d])([TtVv])\.(?=\d)/gu, "$1") // "T.10" → "T10"
    // Keep a dot only as a one-digit decimal ("v10.5"); "13.2024" is a volume then a year.
    .replace(/\.(?!\d(?!\d))|(?<!\d)\./g, " ");
  return { text, group, isScene: true };
}

export interface SceneMarkers {
  /** First year/format word ("2024", "FRENCH", "CBZ"…), or the end of the text. */
  stopIndex: number;
  /** "Int", short for intégrale. */
  intIndex?: number;
  /** Plain-number volumes, only looked for when asked. */
  bare?: { volumes: number[]; firstIndex?: number };
}

/** Markers found only in scene names. `core` is the unscened text with tags removed. */
export function sceneMarkers(core: string, findVolumes: boolean): SceneMarkers {
  const stop = core.match(STOP_RE);
  const stopIndex = stop?.index ?? core.length;
  const markers: SceneMarkers = { stopIndex, intIndex: indexOf(INT_RE, core) };
  if (findVolumes) {
    const stopIsYear = stop !== null && isYear(stop[0]);
    const regionEnd = Math.max(stopIndex, indexOf(YEAR_RE, core) ?? stopIndex);
    markers.bare = findBareVolumes(core.slice(0, regionEnd), stopIndex, stopIsYear);
  }
  return markers;
}

/**
 * Volumes written as plain numbers. The first one must come before `firstLimit` (the first year/format word)
 * and counts only if it is a range, zero-padded, after " - ", or right before the year, so title numbers like
 * "L'histoire des 3 Adolf" or "Saison 3" are left alone. Later ranges up to the year add to it
 * ("1.a.112.officiel.113&114").
 */
function findBareVolumes(
  region: string,
  firstLimit: number,
  stopIsYear: boolean,
): { volumes: number[]; firstIndex?: number } {
  const volumes = new Set<number>();
  let firstIndex: number | undefined;
  for (const m of region.matchAll(BARE_VOLUME_RE)) {
    const from = m[1]!;
    const to = m[2];
    const isRange = to !== undefined && Number(to) >= Number(from);
    if (to !== undefined && !isRange) continue;
    if (firstIndex === undefined) {
      if (m.index >= firstLimit) break;
      const padded = from.length > 1 && from.startsWith("0");
      const afterDash = /-\s*$/.test(region.slice(0, m.index));
      const lastBeforeYear = stopIsYear && region.slice(m.index + m[0].length, firstLimit).trim() === "";
      if (!isRange && !padded && !afterDash && !lastBeforeYear) continue;
      firstIndex = m.index;
    } else if (!isRange) {
      continue;
    }
    addRange(volumes, from, to);
  }
  return { volumes: sorted(volumes), firstIndex };
}

/** Source words in scene names. HYBRiD (mixed scan and retail), or both kinds of word, leave it unset. */
export function sceneSource(core: string): ReleaseSource | undefined {
  if (HYBRID_RE.test(core)) return undefined;
  const scan = SCAN_RE.test(core);
  const digital = RETAIL_RE.test(core);
  if (scan && !digital) return "scan";
  if (digital && !scan) return "digital";
  return undefined;
}
