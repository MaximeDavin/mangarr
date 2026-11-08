export type ReleaseSource = "digital" | "compilation" | "scan";

/**
 * Non-manga content that shares indexer categories with manga.
 * - audiobook: any audio release ("[Audiobook]", M4B, MP3).
 * - novel: light/web novels and other prose ("Light Novel", "LN", "EPUB").
 * - artbook: art books, guidebooks, illustration collections.
 */
export type ContentHint = "audiobook" | "novel" | "artbook";

export interface ParsedRelease {
  /** Cleaned title: everything before the first volume/chapter marker, tags removed. */
  title: string;
  /** `title` split on " | " and " / ", plus "| alt" segments found after the volume marker. */
  titles: string[];
  /** Volume numbers covered, ranges expanded, sorted. Empty when none were found. */
  volumes: number[];
  /** Explicit complete-pack marker: "(complete)", "[Completed]", "(complet)", "Intégrale". */
  isComplete: boolean;
  /** Chapters only, no volume marker. Search drops these. */
  isChapterRelease: boolean;
  /** Volumes plus loose chapters, e.g. "v01-07 + 29-48". */
  hasExtraChapters: boolean;
  /** Release group or ripper, best effort. */
  group?: string;
  /** Special edition hint, e.g. "Omnibus Edition", "Perfect Edition", "Édition Deluxe". */
  editionHint?: string;
  source?: ReleaseSource;
  contentHint?: ContentHint;
  /** File extension, lowercase, when the input was a filename. */
  extension?: string;
}
