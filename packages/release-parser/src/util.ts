/** `src` as a whole word: no letter right before or after it. */
export function word(src: string, flags = "iu"): RegExp {
  return new RegExp(String.raw`(?<!\p{L})(?:${src})(?!\p{L})`, flags);
}

/** `src` as a whole token: no letter or digit right before or after it. */
export function token(src: string, flags = "iu"): RegExp {
  return new RegExp(String.raw`(?<![\p{L}\d])(?:${src})(?![\p{L}\d])`, flags);
}

export const YEAR = String.raw`(?:19|20)\d\d`;
const YEAR_ONLY_RE = new RegExp(`^${YEAR}$`);

export function isYear(s: string): boolean {
  return YEAR_ONLY_RE.test(s);
}

/** Index of the first match, or undefined. */
export function indexOf(re: RegExp, s: string): number | undefined {
  const i = s.search(re);
  return i < 0 ? undefined : i;
}

/** The smallest of the given indexes, or undefined when none is set. */
export function earliest(...indexes: (number | undefined)[]): number | undefined {
  const set = indexes.filter((i) => i !== undefined);
  return set.length > 0 ? Math.min(...set) : undefined;
}

/** Adds `from`, or every whole number from `from` to `to`. Odd ranges (decimals, reversed, huge) add both ends only. */
export function addRange(into: Set<number>, from: string, to: string | undefined): void {
  const start = Number.parseFloat(from);
  if (to === undefined) {
    into.add(start);
    return;
  }
  const end = Number.parseFloat(to);
  if (Number.isInteger(start) && Number.isInteger(end) && end >= start && end - start <= 1000) {
    for (let n = start; n <= end; n++) into.add(n);
  } else {
    into.add(start);
    into.add(end);
  }
}

export function sorted(numbers: Set<number>): number[] {
  return [...numbers].sort((a, b) => a - b);
}
