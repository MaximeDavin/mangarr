import { sceneMarkers, sceneSource, unscene } from "./scene";
import type { ContentHint, ParsedRelease, ReleaseSource } from "./types";
import { addRange, earliest, indexOf, isYear, sorted, token, word, YEAR } from "./util";

const EXT_RE = /\.(?:cbz|cbr|zip|rar|7z|epub|pdf)$/i;
const TAG_RE = /\[([^\]]*)\]|\(([^)]*)\)/g;

const NUM = String.raw`\d+(?:\.\d+)?`;
// "v"/"t" must touch the number ("v01", "T12"); the long forms may have a dot/space/"#" ("Vol. 3", "Tome #105").
const VOL_KW = String.raw`(?:(?:volumes?|vols?|tomes?)\.?\s*(?:#\s*)?|[vt](?=\d))`;
// "a" is an unaccented "à" ("T01 a T34"); a bare space joins two marked volumes ("T01 T36").
const RANGE_SEP = String.raw`(?:\s*(?:-|~|–|à|to)\s*|\s+a\s+)`;
const VOLUME_RE = token(String.raw`${VOL_KW}(${NUM})(?:(?:${RANGE_SEP}${VOL_KW}?|\s+${VOL_KW})(${NUM}))?`, "giu");
// Japanese: "第001-106巻", "第3巻", "12巻".
const JP_VOLUME_RE = new RegExp(String.raw`(?<!\d)(?:第\s*)?(${NUM})(?:\s*[-~〜～]\s*(${NUM}))?\s*巻`, "gu");
// Plain ranges with no volume keyword, outside tags: "Maximum 01-03", "Pack 01-12", "1 à 50".
// A dash range must start with 1-2 digits: "001-022" is chapters (BARE_CHAPTER_RE).
const BARE_RANGE_RE = /(?<![\p{L}\d.,\-#])(?:pack\s+)?(?:(\d{1,2})-|(\d{1,3})\s+à\s+)(\d{1,3})(?![\p{L}\d.,-])/giu;
// "Pack.4.Volumes": a count of volumes, not volume numbers. Ends the title.
const PACK_COUNT_RE = token(String.raw`pack\s+\d+\s+(?:volumes?|tomes?)`);

// Only where a chapter marker starts matters, so chapter ranges need no pattern.
const CHAPTER_RE = token(String.raw`(?:(?:chapters?|chapitres?|chap|ch)\.?\s*|c(?=\d))${NUM}`);
const CHAPTER_WORD_RE = word("chapters?|chapitres?");
// Bare chapter numbers ("001-022", "0001-1648"). Must be zero-padded or a range, so "Mob Psycho 100" is safe.
const BARE_CHAPTER_RE = /(?<![\p{L}\d,.-])(\d{3,4}(?:\.\d+)?)(?:\s*-\s*(\d{2,4}(?:\.\d+)?))?(?![\p{L}\d,])/gu;

/*
 * Plain numbers right after the title, with no keyword ("One Piece 105", "Berserk - 377"):
 * - 4 digits (not a year), or 200 and up: a chapter. Almost no series reaches 200 volumes.
 * - under 200: a volume only in a filename where a single "(year)" tag follows ("One Piece 105 (2023).cbz").
 *   Release names are left alone: "Mob Psycho 100 (2014-2019)", "Kaiju No. 8 (2024)" are titles.
 * - anything else stays unparsed.
 * Language words may follow ("Berserk - 377 Arabic").
 */
const LANGUAGE_WORDS =
  "arabic|english|eng|en|french|fr|vf|jp|jpn|japanese|raws?|italian|spanish|german|portuguese|russian";
const TRAILING_CHAPTER_RE = new RegExp(String.raw`(?<![\p{L}\d.,\-#])(\d{3,4})(?:\s+(?:${LANGUAGE_WORDS}))*\s*$`, "iu");
const FILE_VOLUME_RE = new RegExp(
  String.raw`(?<![\p{L}\d.,\-#])(?<!(?:no|n°)\.?\s*)(\d{1,3})\s*\(${YEAR}\)(?:\s*(?:\[[^\]]*\]|\([^)]*\)))*\s*$`,
  "iu",
);
const CHAPTER_FROM = 200;

const INTEGRALE_RE = word("int[ée]grale?");
const AS_VOLUME_RE = word(String.raw`as\s+v\d`);
const EXTRA_CHAPTERS_RE = /^\s*\+\s*(?:c|ch\.?\s*)?\d/i;

const EDITION_WORD = String.raw`[ée]dition|deluxe|perfect|kanzenban|omnibus|ultimate|\d-in-\d|full[ -]colou?r|hors[- ]s[ée]ries?|カラー版|完全版|新装版`;
const EDITION_RE = word(EDITION_WORD);
// Edition words next to each other, so "Deluxe Edition" is kept whole.
const EDITION_RUN_RE = word(String.raw`(?:${EDITION_WORD})(?:\s+(?:${EDITION_WORD}))*`);
// Case matters: scene names write "ePUB" for manga in EPUB format, and "ln" can be part of a name.
const NOVEL_RE = word("[Nn]ovel|NOVEL|[Ee]pub|EPUB|LN|WN", "u");
// Any audio release: "[Audiobook]", "Livre audio", ".M4B.", ".MP3.128kbps".
const AUDIOBOOK_RE = /audiobook|livres? audio|(?<!\p{L})(?:m4b|mp3)(?!\p{L})|\d\s*kbps/iu;
const ARTBOOK_RE = word(
  String.raw`art\s*books?|guide\s*books?|fan\s*books?|data\s*books?|recueil d['’]illustrations|illustrations? books?|画集`,
);
// Any four digits, not only 19xx/20xx years: "(2003)", "(2022-2026)", and numbers like "(1350)" that are never a group.
const YEAR_TAG_RE = /^\d{4}(?:\s*-\s*\d{4})?$/;
// "(01-39)", "(39-41+)", "(01-100+3HS)": volumes; whatever follows "+" (extras, hors-séries) is not counted.
const RANGE_TAG_RE = /^(\d{1,3})\s*-\s*(\d{1,3})(?:\s*\+.*)?$/u;
// "(4 HS)": a pack of hors-série (special) volumes.
const HORS_SERIE_TAG_RE = /^\d+\s*(?:HS|hors[- ]s[ée]ries?)$/iu;
// "[Digital-1920]" (with the scan width), "[Ebooks Officiels]", "[eBook officiel-1619]", "[Officiel]".
const DIGITAL_TAG_RE = /^(?:digital|(?:e-?books?\s+)?officiels?)(?:-[\d-]+)?(?:\s*\+\s*digital-compilations?)?$/iu;
const COMPLETE_TAG_RE = /^complet(?:e|ed)?(?!\p{L})/iu;
const NOISE_WORD = `f|fixed|partial|premium|jpe?g-?xl|vostfr|multi|cbz|cbr|pdf|extras?|hq|lq|web|${LANGUAGE_WORDS}`;
// One noise word or a list of them ("[FR CBZ]", "(PDF & CBZ)").
const NOISE_TAG_RE = new RegExp(
  String.raw`^(?:(?:${NOISE_WORD})(?:[\s,/&+]+(?:${NOISE_WORD}))*|v\d+.*|raws?.*|.*translations?.*|.*version.*)$`,
  "iu",
);
const TRAILING_NOISE_RE = /\s+(?:french|vf|fr|multi|eng|english|cbz|cbr|pdf|epub|ebook|ln|wn|web|digital)$/i;

type TagKind =
  | "digital"
  | "compilation"
  | "scan"
  | "complete"
  | "edition"
  | "audiobook"
  | "novel"
  /** Volumes stated only inside a tag: "(Volumes 1-45 + Extras)". */
  | "volumes"
  /** Years, formats, languages…: never a group. */
  | "ignored"
  /** Anything else: a group candidate. */
  | "other";

interface Tag {
  content: string;
  bracket: "[" | "(";
  index: number;
  kind: TagKind;
}

function classifyTag(content: string): TagKind {
  if (!content || YEAR_TAG_RE.test(content)) return "ignored";
  if (isRangeTag(content)) return "volumes";
  if (/^digital-compilations?$/i.test(content)) return "compilation";
  if (DIGITAL_TAG_RE.test(content)) return "digital";
  if (HORS_SERIE_TAG_RE.test(content)) return "edition";
  if (/^(?:scans?|scanlation)$/i.test(content)) return "scan";
  if (AUDIOBOOK_RE.test(content)) return "audiobook";
  if (NOVEL_RE.test(content)) return "novel";
  // Edition before complete, so "(Complete Edition)" is an edition, not a pack.
  if (EDITION_RE.test(content)) return "edition";
  if (COMPLETE_TAG_RE.test(content)) return "complete";
  if (NOISE_TAG_RE.test(content)) return "ignored";
  if (content.search(VOLUME_RE) >= 0) return "volumes";
  return "other";
}

function isRangeTag(content: string): boolean {
  const m = content.match(RANGE_TAG_RE);
  return m !== null && Number(m[2]) > Number(m[1]);
}

function readTags(text: string): Tag[] {
  return [...text.matchAll(TAG_RE)].map((m) => {
    const content = (m[1] ?? m[2] ?? "").trim();
    return { content, bracket: m[1] !== undefined ? "[" : "(", index: m.index, kind: classifyTag(content) };
  });
}

function splitExtension(s: string): { name: string; extension?: string } {
  const dot = s.search(EXT_RE);
  return dot < 0 ? { name: s } : { name: s.slice(0, dot).trim(), extension: s.slice(dot + 1).toLowerCase() };
}

function cleanTitle(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  let previous: string;
  do {
    previous = s;
    s = s.replace(/^[\s\-–—,:|/~+]+/, "").replace(/[\s\-–—,:|/~+]+$/, "");
    s = s.replace(TRAILING_NOISE_RE, "");
  } while (s !== previous);
  return s;
}

function splitTitles(s: string): string[] {
  return s
    .split(/\s+[|/]\s+/)
    .map(cleanTitle)
    .filter((t) => t.length > 0);
}

/** Volume markers ("v01", "Tome 3", "T01-T12", "第1巻"…) in the text outside tags. */
function findVolumes(core: string): {
  volumes: number[];
  firstIndex?: number;
  lastEnd?: number;
  hasExtraChapters: boolean;
} {
  const volumes = new Set<number>();
  let firstIndex: number | undefined;
  let lastEnd: number | undefined;
  let hasExtraChapters = false;
  const matches = [...core.matchAll(VOLUME_RE), ...core.matchAll(JP_VOLUME_RE)].sort((a, b) => a.index - b.index);
  for (const m of matches) {
    addRange(volumes, m[1]!, m[2]);
    firstIndex ??= m.index;
    lastEnd = m.index + m[0].length;
    if (EXTRA_CHAPTERS_RE.test(core.slice(lastEnd))) hasExtraChapters = true;
  }
  return { volumes: sorted(volumes), firstIndex, lastEnd, hasExtraChapters };
}

function volumesFromTags(tags: readonly Tag[]): number[] {
  const volumes = new Set<number>();
  for (const tag of tags) {
    if (tag.kind !== "volumes") continue;
    const range = tag.content.match(RANGE_TAG_RE);
    if (range && isRangeTag(tag.content)) addRange(volumes, range[1]!, range[2]);
    else for (const m of tag.content.matchAll(VOLUME_RE)) addRange(volumes, m[1]!, m[2]);
  }
  return sorted(volumes);
}

/** Plain ranges with no keyword ("Maximum 01-03", "Pack 01-12", "1 à 50"). Only used when nothing else matched. */
function findBareRanges(core: string): { volumes: number[]; firstIndex?: number } {
  const volumes = new Set<number>();
  let firstIndex: number | undefined;
  for (const m of core.matchAll(BARE_RANGE_RE)) {
    const from = (m[1] ?? m[2])!;
    const to = m[3]!;
    if (Number(to) <= Number(from)) continue;
    addRange(volumes, from, to);
    firstIndex ??= m.index;
  }
  return { volumes: sorted(volumes), firstIndex };
}

/** True when the text before `index` has a title in it. */
const hasTitleBefore = (core: string, index: number) => /[\p{L}\d]/u.test(core.slice(0, index));

/**
 * Where the first chapter marker starts: "c001", "Ch. 12", "Chapitre", bare "001-022",
 * or, outside scene names, a plain trailing number that is too big to be a volume ("One Piece 1197").
 */
function findChapterMarker(core: string, isScene: boolean): number | undefined {
  const bare = [...core.matchAll(BARE_CHAPTER_RE)].find((m) => {
    const from = m[1]!;
    const to = m[2];
    const yearRange = isYear(from) && (to === undefined || isYear(to));
    return (from.startsWith("0") || to !== undefined) && !yearRange;
  });
  let trailing: number | undefined;
  const t = isScene ? null : core.match(TRAILING_CHAPTER_RE);
  if (t && !isYear(t[1]!) && Number(t[1]) >= CHAPTER_FROM && hasTitleBefore(core, t.index!)) trailing = t.index;
  return earliest(indexOf(CHAPTER_RE, core), indexOf(CHAPTER_WORD_RE, core), bare?.index, trailing);
}

/** "One Piece 105 (2023).cbz": a plain volume number in a filename, followed by a single year tag. */
function findFileVolume(text: string): { volume: number; index: number } | undefined {
  const m = text.match(FILE_VOLUME_RE);
  if (!m || !hasTitleBefore(text, m.index!)) return undefined;
  const volume = Number(m[1]);
  return volume < CHAPTER_FROM ? { volume, index: m.index! } : undefined;
}

/** A " - " segment naming an edition ("Dragon Ball - Perfect Edition"), else the edition words themselves. */
function findEditionInTitle(title: string): string | undefined {
  const segments = title.split(/\s+[-–—]\s+/);
  return segments.slice(1).find((s) => EDITION_RE.test(s)) ?? title.match(EDITION_RUN_RE)?.[0];
}

function findSource(tags: readonly Tag[], core: string, isScene: boolean): ReleaseSource | undefined {
  if (tags.some((t) => t.kind === "digital")) return "digital";
  if (tags.some((t) => t.kind === "compilation") || AS_VOLUME_RE.test(core)) return "compilation";
  if (tags.some((t) => t.kind === "scan")) return "scan";
  return isScene ? sceneSource(core) : undefined;
}

export function parseRelease(input: string): ParsedRelease {
  const { name, extension } = splitExtension(input.trim());
  const scene = unscene(name);
  const text = scene.text.trim();
  const tags = readTags(text);
  // Tags blanked out with as many spaces, so indexes in `core` are indexes in `text`.
  const core = text.replace(TAG_RE, (tag) => " ".repeat(tag.length));

  // Markers. Each one gives where it starts; the title is everything before the earliest one.
  const marked = findVolumes(core);
  let volumes = marked.volumes.length > 0 ? marked.volumes : volumesFromTags(tags);
  const chapterIndex = findChapterMarker(core, scene.isScene);
  const integraleIndex = indexOf(INTEGRALE_RE, core);
  const sceneMarks = scene.isScene ? sceneMarkers(core, volumes.length === 0 && chapterIndex === undefined) : undefined;
  if (sceneMarks?.bare) volumes = sceneMarks.bare.volumes;

  // Last resorts, when no marker gave volumes and nothing reads as chapters.
  let bareRangeIndex: number | undefined;
  let fileVolumeIndex: number | undefined;
  if (volumes.length === 0 && chapterIndex === undefined) {
    const bare = findBareRanges(core);
    if (bare.volumes.length > 0) {
      volumes = bare.volumes;
      bareRangeIndex = bare.firstIndex;
    } else if (extension && !scene.isScene) {
      const file = findFileVolume(text);
      if (file) {
        volumes = [file.volume];
        fileVolumeIndex = file.index;
      }
    }
  }

  const titleEnd = earliest(
    marked.firstIndex,
    chapterIndex,
    integraleIndex,
    sceneMarks?.intIndex,
    sceneMarks?.stopIndex,
    sceneMarks?.bare?.firstIndex,
    bareRangeIndex,
    fileVolumeIndex,
    indexOf(PACK_COUNT_RE, core),
  );

  // Titles, plus "| alt" segments right after the last volume marker.
  const title = cleanTitle(core.slice(0, titleEnd));
  const titles = splitTitles(title);
  const tail = marked.lastEnd === undefined ? "" : core.slice(marked.lastEnd);
  if (/^\s*\|/.test(tail)) {
    for (const alt of splitTitles(tail.replace(/^\s*\|/, ""))) if (!titles.includes(alt)) titles.push(alt);
  }

  const isComplete =
    tags.some((t) => t.kind === "complete") || integraleIndex !== undefined || sceneMarks?.intIndex !== undefined;
  const editionHint = tags.find((t) => t.kind === "edition")?.content ?? findEditionInTitle(title);
  // The raw input, so a ".EPUB" extension still counts.
  const raw = input.trim();
  const contentHint: ContentHint | undefined = AUDIOBOOK_RE.test(raw)
    ? "audiobook"
    : NOVEL_RE.test(raw)
      ? "novel"
      : ARTBOOK_RE.test(text)
        ? "artbook"
        : undefined;
  const source = findSource(tags, core, scene.isScene);

  // Group: scene suffix, else a leading [Group], else the last unclassified tag.
  const others = tags.filter((t) => t.kind === "other");
  const leading = others.find((t) => t.index === 0 && t.bracket === "[");
  const group = scene.group ?? leading?.content ?? others.at(-1)?.content;

  const result: ParsedRelease = {
    title,
    titles,
    volumes,
    isComplete,
    isChapterRelease: volumes.length === 0 && chapterIndex !== undefined,
    hasExtraChapters: marked.hasExtraChapters,
  };
  if (group) result.group = group;
  if (editionHint) result.editionHint = editionHint;
  if (source) result.source = source;
  if (contentHint) result.contentHint = contentHint;
  if (extension) result.extension = extension;
  return result;
}
