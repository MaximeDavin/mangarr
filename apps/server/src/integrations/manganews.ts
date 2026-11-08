// The Manga-News dataset (spec §6.5): a CSV on data.gouv.fr, downloaded when you press
// "Refresh dataset". This file fetches and parses it; library/manganews.ts stores it.
//
// Columns (the July 2026 file): site_id, url, title, letter, publisher, volumes, artists, writers,
// genres, cover_url, first_seen_at, last_seen_at. Columns are found by name, so a reordered file
// still loads. `first_seen_at` and `last_seen_at` are when the scraper saw the page, not
// publication dates, so they are not kept.

import { errorMessage } from "../errors";
import { type Fetch, UpstreamError } from "./upstream";

export interface MangaNewsRow {
  /** Manga-News' `site_id`. */
  id: number;
  url: string;
  title: string;
  publisher: string | null;
  /** Volumes published in French. 0 for an announced series. */
  volumeCount: number;
  artists: string | null;
  writers: string | null;
  genres: string[];
  coverUrl: string | null;
}

export interface ParsedDataset {
  rows: MangaNewsRow[];
  /** Lines that didn't give a usable row (no id, no title, a repeated id, a bad count). */
  skipped: number;
}

/** About 3 MB in 2026; anything far bigger is not this file. */
const maxBytes = 50 * 1024 * 1024;
const required = ["site_id", "url", "title", "publisher", "volumes"] as const;

/** RFC 4180: commas, double quotes around fields that need them, `""` for a quote, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const orNull = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Turns the CSV text into rows. Throws when the columns mangarr needs are missing. */
export function parseMangaNewsCsv(text: string): ParsedDataset {
  const [header, ...lines] = parseCsv(text);
  const columns = new Map((header ?? []).map((name, index) => [name.trim().toLowerCase(), index]));
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new UpstreamError("invalid_response", `The file is not the Manga-News CSV: no ${missing.join(", ")} column`);
  }
  const at = (line: string[], name: string) => {
    const index = columns.get(name);
    return index === undefined ? undefined : line[index];
  };

  const rows: MangaNewsRow[] = [];
  const seen = new Set<number>();
  let skipped = 0;
  for (const line of lines) {
    if (line.length === 1 && line[0]!.trim() === "") continue;
    const id = Number(at(line, "site_id"));
    const title = orNull(at(line, "title"));
    const url = orNull(at(line, "url"));
    const volumes = (at(line, "volumes") ?? "").trim();
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !title || !url || !/^\d+$/.test(volumes)) {
      skipped++;
      continue;
    }
    seen.add(id);
    rows.push({
      id,
      url,
      title,
      publisher: orNull(at(line, "publisher")),
      volumeCount: Number(volumes),
      artists: orNull(at(line, "artists")),
      writers: orNull(at(line, "writers")),
      genres: [
        ...new Set(
          (at(line, "genres") ?? "")
            .split("|")
            .map((g) => g.trim())
            .filter(Boolean),
        ),
      ],
      coverUrl: orNull(at(line, "cover_url")),
    });
  }
  return { rows, skipped };
}

const isTimeout = (error: unknown) => (error as { name?: unknown })?.name === "TimeoutError";

/** Downloads the CSV. Redirects are followed: data.gouv.fr's "latest" link redirects to the file. */
export async function downloadMangaNewsCsv(
  url: string,
  {
    fetch: fetchImpl = (request) => fetch(request),
    timeoutMs = 120_000,
    signal,
  }: { fetch?: Fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const host = URL.parse(url)?.host ?? url;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetchImpl(
      new Request(url, { headers: { Accept: "text/csv, */*" }, signal: AbortSignal.any(signals) }),
    );
    const length = Number(response.headers.get("content-length"));
    if (length > maxBytes)
      throw new UpstreamError("invalid_response", `The file at ${host} is too big to be the Manga-News CSV`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof UpstreamError || signal?.aborted) throw error;
    if (isTimeout(error))
      throw new UpstreamError("timeout", `${host} did not send the Manga-News CSV within ${timeoutMs / 1000} s`, {
        cause: error,
      });
    throw new UpstreamError(
      "unreachable",
      `Could not download the Manga-News CSV from ${host}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (response.status === 404)
    throw new UpstreamError("not_found", `No file at the Manga-News CSV URL (${host} answered 404)`, { status: 404 });
  if (!response.ok)
    throw new UpstreamError("http", `${host} answered ${response.status} for the Manga-News CSV`, {
      status: response.status,
    });
  if (bytes.length > maxBytes)
    throw new UpstreamError("invalid_response", `The file at ${host} is too big to be the Manga-News CSV`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new UpstreamError("invalid_response", "The Manga-News CSV is not UTF-8 text", { cause: error });
  }
}
