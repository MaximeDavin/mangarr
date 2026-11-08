// What the add-series flow pre-fills from MangaBaka (spec §4.3, §6.4, §7.1).
// Pure functions: no I/O, so they're easy to test against recorded records.

import { normalizeTitle } from "@mangarr/release-parser";
import type { MangaBakaCollection, MangaBakaSeries, MangaBakaTitle } from "../integrations/mangabaka";

/**
 * True when a MangaBaka language tag belongs to the series language: the same tag, or a more
 * specific one (`zh` matches `zh-Hant`, `pt` matches `pt-br`). `pt-br` doesn't match plain `pt`.
 */
export function sameLanguage(tag: string, code: string): boolean {
  const t = tag.toLowerCase();
  const c = code.toLowerCase();
  return t === c || t.startsWith(`${c}-`);
}

/** Only Latin-script titles can show up in the release names mangarr's indexers carry. */
const latinOnly = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}\p{M}]+$/u;
const hasLetter = /\p{L}/u;
const isLatin = (title: string) => latinOnly.test(title) && hasLetter.test(title);

/** Two names that titleMatch() would treat the same (it ignores spaces inside a match). */
export const matchKey = (name: string) => normalizeTitle(name).replace(/\s+/g, "");

export interface TermsDraft {
  /**
   * Sent to Prowlarr, one query each, so only primary titles: the series-language one, then the
   * romanized and native ones.
   */
  searchTerms: string[];
  /** Accepted when matching, never queried: MangaBaka's main title and the other Latin-script titles. */
  aliases: string[];
}

export function draftTerms(series: MangaBakaSeries, languageCode: string): TermsDraft {
  const original = series.originalLanguage;
  const inLanguage = (t: MangaBakaTitle) => sameLanguage(t.language, languageCode);
  const romanized = (t: MangaBakaTitle) =>
    t.isPrimary && original !== undefined && t.language.toLowerCase() === `${original.toLowerCase()}-latn`;
  const native = (t: MangaBakaTitle) =>
    t.isPrimary && original !== undefined && t.language.toLowerCase() === original.toLowerCase();

  const seen = new Set<string>();
  const take = (list: string[], title: string | undefined) => {
    const trimmed = title?.trim();
    if (!trimmed) return;
    const key = matchKey(trimmed);
    // A title of only punctuation normalizes to "": it could never match anything.
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push(trimmed);
  };

  const searchTerms: string[] = [];
  const titles = series.titles;
  // The first search term becomes the display title.
  for (const t of titles.filter((t) => inLanguage(t) && t.isPrimary)) take(searchTerms, t.title);
  // A language MangaBaka has no primary title for: its main title is the best guess.
  if (searchTerms.length === 0) take(searchTerms, series.title);
  for (const t of titles.filter(romanized)) take(searchTerms, t.title);
  take(searchTerms, series.romanizedTitle);
  for (const t of titles.filter(native)) take(searchTerms, t.title);
  take(searchTerms, series.nativeTitle);

  const aliases: string[] = [];
  take(aliases, series.title);
  // Other titles in the series language first, whatever their script.
  for (const t of titles.filter(inLanguage)) take(aliases, t.title);
  for (const t of titles) if (isLatin(t.title)) take(aliases, t.title);

  return { searchTerms, aliases };
}

/** Authors then artists, without repeats (case-insensitive). */
export function draftAuthors(series: MangaBakaSeries): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [...series.authors, ...series.artists]) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      names.push(trimmed);
    }
  }
  return names;
}

/** The publishers in the series language, or undefined. */
export function draftPublisher(series: MangaBakaSeries, languageCode: string): string | undefined {
  const names = [
    ...new Set(
      series.publishers.filter((p) => p.language && sameLanguage(p.language, languageCode)).map((p) => p.name),
    ),
  ];
  return names.length > 0 ? names.sort((a, b) => a.localeCompare(b)).join(", ") : undefined;
}

export interface VolumeCountDraft {
  volumeCount: number | null;
  /** Where the count came from. */
  from: "collection" | "final_volume" | null;
  /** Volume collections in the series language, to choose another edition's count. Largest first. */
  options: MangaBakaCollection[];
}

const isStandard = (c: MangaBakaCollection) => /\bstandard\b/i.test(c.edition ?? "");

/**
 * The volume count: from the series-language collection (the Standard Edition when there is one,
 * taking its largest count, as digital often runs ahead of print), or else MangaBaka's
 * `final_volume`, the count in the original language. Always editable afterwards.
 */
export function draftVolumeCount(
  series: MangaBakaSeries,
  collections: MangaBakaCollection[],
  languageCode: string,
): VolumeCountDraft {
  const options = collections
    .filter((c) => c.type === "volume" && c.volumeCount > 0 && sameLanguage(c.language, languageCode))
    .sort((a, b) => b.volumeCount - a.volumeCount);
  const best = options.find(isStandard) ?? options[0];
  if (best) return { volumeCount: best.volumeCount, from: "collection", options };
  if (series.finalVolume !== undefined) {
    return { volumeCount: Math.floor(series.finalVolume), from: "final_volume", options };
  }
  return { volumeCount: null, from: null, options };
}
