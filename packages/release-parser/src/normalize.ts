import type { ParsedRelease } from "./types";

/** Lowercase, strip diacritics, drop apostrophes and punctuation, collapse whitespace. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** French manga publishers, normalized. French scene names often put one after the title. */
const PUBLISHERS = [
  "akata",
  "ankama",
  "black box",
  "casterman",
  "delcourt",
  "doki doki",
  "glenat",
  "hikari",
  "kana",
  "kaze",
  "ki oon",
  "kurokawa",
  "mangetsu",
  "meian",
  "nazca",
  "noeve",
  "ototo",
  "panini",
  "pika",
  "soleil",
  "taifu",
  "tonkam",
  "vega",
];
const PUBLISHER_KEYS = PUBLISHERS.map((p) => p.replaceAll(" ", ""));

/** Words that differ between releases of the same title: "Tales of Demons & Gods" / "… and Gods" / "… et Gods". */
const CONNECTORS = new Set(["and", "et"]);

/** Roman numerals read as numbers. I, V and X are left out: they are too often plain letters ("Spy x Family"). */
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };

/** `normalizeTitle` words, with "×" read as "x", "and" / "et" / "&" dropped and II–IX read as numbers. */
function matchWords(s: string): string[] {
  return normalizeTitle(s.replaceAll("×", " x "))
    .split(" ")
    .filter((w) => w.length > 0 && !CONNECTORS.has(w))
    .map((w) => ROMAN[w] ?? w);
}

/** Words joined with no spaces, so "One-Punch Man" = "Onepunch Man" and "Ki-oon" = "Kioon". */
const matchKey = (words: readonly string[]) => words.join("");

/** True when `s` is empty or can be cut entirely into pieces from `pieces`. */
function isMadeOf(s: string, pieces: readonly string[]): boolean {
  const ok = [true];
  for (let end = 1; end <= s.length; end++) {
    ok[end] = pieces.some((p) => p.length <= end && ok[end - p.length] === true && s.startsWith(p, end - p.length));
  }
  return ok[s.length] === true;
}

/** What a release title is compared against. */
export interface MatchTarget {
  /** Every name the series goes by: its search terms and aliases. */
  names: readonly string[];
  /** Author and artist names. When given, words around the name must come from these (or a publisher). */
  authors?: readonly string[];
}

export type TitleMatch = "exact" | "partial";

/**
 * - "exact": a parsed title equals one of the names.
 * - "partial": a parsed title contains a name as whole words, and the words around it are allowed:
 *   - before it: author words (any order, glued or not: "Ishida Sui", "OdaBoichi"); any words when no authors are known;
 *   - after it: author words or known French publishers ("…Call of the Night Kurokawa", "…Lion Umino").
 *   So "Berserk of Gluttony" does not match "Berserk", and "Tokyo Ghoul Re" does not match "Tokyo Ghoul".
 *
 * Words are compared after `normalizeTitle`, with "×" read as "x", "and" / "et" / "&" ignored, II–IX read as
 * numbers and spaces ignored inside a match ("One-Punch" = "Onepunch").
 */
export function titleMatch(release: Pick<ParsedRelease, "titles">, target: MatchTarget): TitleMatch | undefined {
  const authorWords = [...new Set((target.authors ?? []).flatMap(matchWords))];
  const matcher: Matcher = {
    names: new Set(target.names.map((n) => matchKey(matchWords(n))).filter((k) => k.length > 0)),
    authorWords,
    trailingPieces: [...authorWords, ...PUBLISHER_KEYS],
  };
  const titles = release.titles.map(matchWords).filter((words) => words.length > 0);

  if (titles.some((words) => matcher.names.has(matchKey(words)))) return "exact";
  if (titles.some((words) => containsName(words, matcher))) return "partial";
  return undefined;
}

interface Matcher {
  /** Name keys (`matchKey`). */
  names: Set<string>;
  /** Allowed before a name. Empty means any words are. */
  authorWords: readonly string[];
  /** Allowed after a name: author words and publishers. */
  trailingPieces: readonly string[];
}

/** True when a run of `words` is a name and the words around it are allowed (see `titleMatch`). */
function containsName(words: readonly string[], m: Matcher): boolean {
  for (let start = 0; start < words.length; start++) {
    let key = "";
    for (let end = start; end < words.length; end++) {
      key += words[end];
      if (!m.names.has(key)) continue;
      const before = matchKey(words.slice(0, start));
      const after = matchKey(words.slice(end + 1));
      const beforeOk = m.authorWords.length === 0 || isMadeOf(before, m.authorWords);
      if (beforeOk && isMadeOf(after, m.trailingPieces)) return true;
    }
  }
  return false;
}
