# mangarr — v0 specification

Status: draft · Last updated: 2026-11-07

mangarr is a self-hosted, *arr-style service that finds and downloads **manga volumes (tankōbon), never chapters**, in any configured language, and files them into a Komga library.

It is built from scratch for one person's workflow. It copies *arr conventions only where they pay off right away: Prowlarr search, qBittorrent handling, settings stored in the database, one Docker image.

---

## 1. Goals

### 1.1 The v0 loop

1. **Add a series**: search MangaBaka, choose a language, confirm the search terms and display title, then the folder.
2. **Search**: interactive search through Prowlarr, using that language's indexers.
3. **Grab**: you choose a release, and mangarr sends it to qBittorrent.
4. **Import**: when the download finishes, mangarr copies the volume files into the library with clean names.
5. **Komga**: mangarr triggers a rescan of that language's library.

### 1.2 Principles

- **You stay in control of what gets downloaded.** There is no automatic grabbing in v0.
- **The filesystem decides what you own.** Volumes you already own are found by scanning the series folders, not by reading Komga or the database alone.
- **Languages are configuration.** No code branches on a language code. Adding German means adding a Language record.
- **mangarr never deletes anything outside its library writes.** It never removes torrents and never overwrites an existing volume.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Language** | A configured language (e.g. `en`, `fr`). It sets the indexers, library root, Komga library and volume-count source. |
| **Series** | One work in **one language and one edition**. *One Piece (EN)*, *One Piece (FR)* and *Berserk Deluxe (EN)* are three separate series. |
| **Volume** | A numbered tankōbon in a series. The number may be a decimal (`10.5`). In v0 a volume exists as a row only when mangarr owns its file on disk. |
| **Release** | A search result from Prowlarr: one torrent, which may cover one volume or many. |
| **Download** | A release mangarr has grabbed and is tracking by its info-hash. |
| **Pack** | A release covering several volumes (`v01-20`, `Complete`, `Intégrale`). |

---

## 3. Deployment and runtime

- **One Docker image** serves both the API (§8) and the built React UI on a single port, **6262** by default (no other *arr app uses it). The HTTP server is plain `Bun.serve`, with oRPC's fetch handlers mounted on it.
- **Volumes:**
  - `/config` holds the SQLite database.
  - `/data` is the same mount that qBittorrent and Komga see, e.g. `/data/torrents` and `/data/media/manga/{en,fr}`. mangarr assumes **the same paths in every container**, with no remote path mapping in v0.
- **Environment variables** cover infrastructure only: `PORT`, `PUID`, `PGID`, `TZ`, and optionally `CONFIG_DIR`. Everything else (URLs, API keys, languages) is set in the UI and stored in SQLite.
- **Logs** go to stdout/stderr, for `docker logs`.
- **Runtime:** Bun (≥ 1.4), TypeScript, SQLite through Bun's built-in `bun:sqlite`. Bun runs the TypeScript directly; type checking is a separate `tsc --noEmit` step.
- **Tooling:** Bun is also the package manager (workspaces, `bun.lock`) and the test runner (`bun test`).
- **Portability:** server code sticks to web standards (`Request`/`Response`, `fetch`) and portable libraries, so moving back to Node stays cheap if Bun causes trouble.
- **Background work** runs as an in-process job loop. There is no Redis and no external queue.

### 3.1 Repository layout (Bun workspaces)

```
apps/
  server/            # oRPC API, job loop, integrations, serves web build
  web/               # Vite + React SPA
packages/
  release-parser/    # pure parsing lib + fixture-driven tests
docs/
  spec-v0.md
```

---

## 4. Data model

- **Database access** uses Drizzle ORM 1.0 over `bun:sqlite`. The schema is in `apps/server/src/db/schema.ts`, and the relations for relational queries are in `relations.ts`.
- **Migrations:** `bun run db:generate` writes SQL migrations to `apps/server/drizzle/`. The server applies pending migrations on every start, so the Docker image needs no extra tool. Foreign keys are off while migrating (SQLite's table-rebuild procedure needs this), and the server refuses to start if a migration leaves a row pointing at a missing parent.
- **Storage conventions:** SQL names are snake_case. Arrays and objects are stored as JSON text, and timestamps as epoch milliseconds. Defaults are set in SQL, enum columns have a CHECK constraint, and every foreign-key column is indexed. Index names follow `{table}_{column}_idx`.

### 4.1 Language

| Field | Notes |
|---|---|
| `id` | |
| `code` | e.g. `en`, `fr`. Unique. |
| `name` | Display name. |
| `prowlarrIndexerIds` | `int[]`. Which Prowlarr indexers to search for this language. |
| `prowlarrCategories` | `int[]`, optional, empty by default (all categories). |
| `rootFolder` | e.g. `/data/media/manga/fr`. |
| `komgaLibraryId` | Nullable. When null, no Komga scan is triggered. Checked against Komga when saved (§6.3). |
| `komgaScanError`, `komgaScanErrorAt` | Nullable. Why the last Komga scan of that library failed, shown in Settings. Cleared by a scan that works, or by choosing another library. |
| `useMangaNewsDataset` | `bool`. When true, the add-series flow offers to link a Manga-News row (see §6.5). In practice this is on for `fr` only, but the code never checks the code. |

### 4.2 Series

| Field | Notes |
|---|---|
| `id` | |
| `languageId` | FK. Each series belongs to exactly one language. |
| `mangabakaId` | Main external ID. Unique per language: the same manga can be added once in each language. |
| `externalIds` | JSON with AniList, MAL and MangaUpdates IDs, copied from MangaBaka. |
| `displayTitle` | Used for the folder and file names. Chosen from the search terms when the series is added. |
| `folderPath` | Absolute path. Defaults to `<rootFolder>/<displayTitle>`, or an existing folder you pick. |
| `coverUrl`, `status`, `publisher` | Cached from MangaBaka (and from Manga-News for the publisher, when linked). |
| `authors` | `string[]`, editable. Author and artist names, prefilled from MangaBaka. Title matching uses them to accept author-first release names (§5.3). |
| `volumeCount` | Nullable, editable. Only used to show which volumes are missing. |
| `volumeCountSource` | `mangabaka`, `manganews` or `manual`. |
| `mangaNewsSeriesId` | Nullable FK to the Manga-News row, picked by hand (§7.1). Cleared when a dataset refresh drops that row. |
| `metadataJson`, `metadataFetchedAt` | Cached MangaBaka record. Refreshed on demand. |
| `lastScannedAt` | |
| `scanWarnings` | `{ file?, message }[]`. Warnings from the last disk scan (§7.5), shown on the series page. |

### 4.3 SearchTerm

`id`, `seriesId`, `term`, `kind`. Fully editable.

- **`search`**: sent to Prowlarr, and accepted when matching results. Prefilled from MangaBaka's **primary** titles in the series language, plus the primary romaji and native titles. Each search term is one Prowlarr query, so non-primary titles are not used. When MangaBaka has no primary title in the series language, its main title is used.
- **`alias`**: accepted when matching results, never sent to Prowlarr. Prefilled from MangaBaka's main title, its other titles in the series language, and its other **Latin-script** titles (titles in other scripts never appear in release names). Names that `titleMatch()` would read the same are listed once. Add one by hand when a release you want is matched only partially or not at all.

Keeping the two apart (like Sonarr's search term vs parse term) means a name can be recognised without adding a query.

### 4.4 Volume (owned files only)

| Field | Notes |
|---|---|
| `id`, `seriesId` | |
| `number` | Decimal. Unique per series. |
| `filePath`, `fileSize`, `format` | `filePath` is unique. `format` is `cbz` or `cbr`. |
| `source` | `scan` or `import`. |

These states are **derived** and never stored:

- **Missing** = numbers from 1 to `volumeCount` that have no Volume row.
- **Downloading** = missing numbers that appear in an active Download's `expectedVolumes`.

### 4.5 Download

| Field | Notes |
|---|---|
| `id`, `seriesId` | |
| `infoHash` | v1 SHA-1 info-hash, lowercase hex. Unique. |
| `releaseTitle`, `indexerName`, `prowlarrGuid`, `size` | |
| `expectedVolumes` | From parsing the release title. Empty for complete packs with no numbers (`isComplete` and no `volumes`); the import step works out the volumes from the files. |
| `titleMatch` | `exact`, `partial` or `none`, as shown when the release was grabbed. A `partial` or `none` grab usually means the series needs an alias. |
| `status` | `downloading` → `importing` → `imported`. It can also be `needs_attention` or `missing_from_client`. |
| `statusMessage` | Reason, when the status is `needs_attention`. |
| `grabbedAt`, `completedAt`, `importedAt` | |

### 4.6 ImportLogEntry

`id`, `downloadId`, `sourceFile`, `action`, `volumeNumber?`, `destPath?`, `message?`, `createdAt`.

`action` is one of:

- `imported`
- `skipped_owned`
- `skipped_unparseable`
- `skipped_format`
- `error`

### 4.7 MangaNewsSeries

One row per series in the Manga-News CSV (§6.5).

| Field | Notes |
|---|---|
| `id` | Manga-News' own `site_id`, so series links survive a refresh. |
| `url`, `title` | `title` as Manga-News files it, with the article last: `Envol (l')`. The API also gives a `displayTitle` with the article first (`L'Envol`). |
| `searchTitle` | The display title, normalized (`normalizeTitle()`). Search compares it. |
| `publisher` | French publisher. Nullable. |
| `volumeCount` | Volumes published in French. 0 for a series that is only announced. |
| `artists`, `writers`, `genres`, `coverUrl` | Shown when picking a row. `genres` is a list. |
| `datasetImportedAt` | When the refresh that last wrote the row ran. |

The CSV's `first_seen_at` and `last_seen_at` are when its scraper saw the page, not publication dates, so they are not kept.

### 4.8 Settings (key/value)

- Prowlarr: URL and API key.
- qBittorrent: URL, username, password, category (default `mangarr`).
- Komga: URL and API key.
- Manga-News CSV URL (default: data.gouv.fr's link to the latest version of the file).
- Poll interval (default 30 s).
- mangarr API key, for scripts and dashboards (§8): generated on first start, and can be regenerated.

### 4.9 User

One account in v0, created on first start (§8).

| Field | Notes |
|---|---|
| `id` | |
| `username` | Unique. |
| `passwordHash` | Argon2id, from `Bun.password`. |
| `createdAt` | |

### 4.10 Session

| Field | Notes |
|---|---|
| `id` | SHA-256 of the cookie's token, so a copy of the database can't be used to sign in. |
| `userId` | Deleted with the user. |
| `createdAt` | |
| `expiresAt` | 30 days after the last renewal. A session used with less than 15 days left is renewed. |

---

## 5. Release parser (`packages/release-parser`)

A pure function with no I/O. Imports use the **same parser** on filenames.

```ts
parseRelease(input: string): {
  title: string;              // cleaned title, before the first volume/chapter marker
  titles: string[];           // title split on " | " and " / " (+ "| alt" after the marker)
  volumes: number[];          // expanded and sorted; [] = none found
  isComplete: boolean;        // "(complete)", "[Completed]", "(complet)", "Intégrale"
  isChapterRelease: boolean;  // chapter markers and no volume marker
  hasExtraChapters: boolean;  // "v01-07 + 29-48"
  group?: string;             // e.g. "1r0n, Ushi"
  editionHint?: string;       // Omnibus Edition, Perfect Edition, Édition Deluxe…
  source?: "digital" | "compilation" | "scan"; // compilation = "001-022 as v01-04"
  contentHint?: "audiobook" | "novel" | "artbook"; // non-manga noise in the same indexer category
  extension?: string;         // when the input is a filename
}
```

Packs with no numbers (`Complete`, `Intégrale`) have `volumes: []` and `isComplete: true`, and the import step works out the volumes from the files. `normalizeTitle()` and `titleMatch()` (§5.3) are in the same package.

### 5.1 Patterns it must handle

- **Volume markers:**
  - `v01`, `v1`, `Vol. 3`, `Vol 3`, `Volume 03`
  - `T01`, `Tome 1` and `Tome #105` (the French convention)
  - Japanese `第3巻`
  - decimals (`v10.5`)
- **Ranges:**
  - `v01-20`, `v01-v20`, `Vol. 1-12`, `T01-T12`, `Tome 1-12`, `第001-106巻`
  - A range alone in a tag: `(01-39)`, `(39-41+)`, `(01-100+3HS)`. Whatever follows the `+` (extras, specials) is not counted.
  - A plain range with no volume marker, used only when nothing else gave volumes or chapters: `Maximum 01-03`, `Pack 01-12`, `1 à 50`, `Berserk_FR_01-42`. A dash range must start with 1 or 2 digits, because `001-022` is a chapter range.
  - Ranges are expanded into the `volumes` list.
- **Packs:**
  - `isComplete` is set by a complete tag (`(Complete)`, `[Completed]`, `(complet)`), by `Intégrale` anywhere, or by `Int` in a scene name (`Akira.Int.T1-14`).
  - A bare `Complete` outside a tag is not a pack marker: it is usually part of a title (`Kuro - The Complete Edition`).
  - Packs with no numbers give `volumes: []`. The real volumes are worked out from the files at import time.
  - Hors-série packs (`(4 HS)`, `HORS-SERIE.Pack.4.Volumes`) hold special volumes, not volumes of the series: they give `volumes: []`, and `editionHint` names them (`4 HS`, `HORS-SERIE`). A count such as `Pack 4 Volumes` is never read as volume numbers.
- **Chapter markers** (`c001`, `c001-010`, `Ch.`, `Chapter`, `Chapitre`) set `isChapterRelease`, unless volume markers are also present.
- **Bare numbers** right after the title, with no marker (scene names have their own rules):
  - 4 digits that aren't a year, or 200 and up, are a chapter (`One Piece 1197 [JP]`, `Berserk - 377 Arabic.cbz`). Hardly any series reaches 200 volumes.
  - Under 200 is a volume only in a filename where a single `(year)` tag follows (`One Piece 105 (2023).cbz`).
  - Anything else stays unparsed, so numbered titles like `Mob Psycho 100 (2014-2019)` and `Kaiju No. 8 (2024)` keep their number. Known limit: the filename `Mob Psycho 100 (2014).cbz` reads as volume 100.
- **Groups and tags:**
  - `group` is, in this order: the scene suffix (`…eBook-NoTag`, with a trailing marker split off: `…Digital-danke-Empire-T01-T40` gives `danke-Empire`), a leading `[Group]`, or the last tag that isn't a year, format, language, source, edition or other known word (`(Rillant)`, `(1r0n, Ushi)`).
  - `(Digital)`, `[Digital-1920]`, `[Ebooks Officiels]`, `[eBook officiel-1619]` and similar set `source`.
  - Trailing `(…)` and `[…]` tags are stripped from `title`.
- **Content hints** (`contentHint`), for non-manga releases in manga categories:
  - `audiobook`: `[Audiobook]`, M4B, MP3.
  - `novel`: `Light Novel`, `LN`, `WN`, `EPUB` (a `.EPUB` extension counts).
  - `artbook`: art books, guidebooks, `Recueil d'illustrations`, `画集`.
- **Normalization** (`normalizeTitle()`): lowercase, strip diacritics, drop punctuation, collapse whitespace.

### 5.2 Tests

Tests are fixture-driven and run with `bun test`:

- Files such as `fixtures/nyaa.json` and `fixtures/fr-tracker.json` hold `{ input, expected }` pairs.
- **Start with about 50 real titles per indexer, copied before writing any parser code.**
- Every unparseable filename found in an import log becomes a new fixture.

### 5.3 Title matching (`titleMatch()`)

```ts
titleMatch(release: { titles: string[] }, target: {
  names: string[];     // the series' search terms and aliases (§4.3)
  authors?: string[];  // the series' authors (§4.2)
}): "exact" | "partial" | undefined
```

Matching only ever compares a release against **the series being searched**, never against the whole library.

- **Comparison:** both sides go through `normalizeTitle()`, then:
  - `×` reads as `x` (`HUNTER×HUNTER` = `Hunter X Hunter`);
  - `and`, `et` and `&` are ignored;
  - `II` to `IX` read as numbers (`I`, `V` and `X` are left alone because they are often plain letters);
  - spaces are ignored inside a match (`One-Punch` = `Onepunch`, `Ki-oon` = `Kioon`).
- **exact:** a parsed title equals one of the names.
- **partial:** a parsed title contains a name as whole words, and the words around it are allowed:
  - **Before the name:** author words only, in any order, even glued together (`Sui.Ishida…`, `Endo.Tatsuya…`, `Eiichiro.OdaBoichi…`). When the series has no authors, any words are accepted.
  - **After the name:** author words or known French publishers (`…Call.of.the.Night.Kurokawa`, `…Like.a.Lion.Umino`).
  - Anything else rejects the match, so `Berserk of Gluttony` doesn't match `Berserk` and `Tokyo Ghoul Re` doesn't match `Tokyo Ghoul`.
- **undefined:** no match.

There is no fuzzy (edit-distance) matching. A release name that only matches partially, or not at all, is fixed by adding an alias.

---

## 6. Integrations

### 6.1 Prowlarr (search only)

- **Search:** `GET /api/v1/search` with `query`, the Language's `indexerIds`, optional `categories`, and the `X-Api-Key` header.
- **Settings screen:** `GET /api/v1/indexer` fills the indexer picker for each language.
- **Fields used from each result:** `guid`, `title`, `size`, `seeders`, `leechers`, `indexer`, `downloadUrl`, `magnetUrl`, `infoHash`, `publishDate`.
- mangarr does **not** register as a Prowlarr "Application".

### 6.2 qBittorrent (Web API v2)

- **Authentication:** `POST /api/v2/auth/login` gives a session cookie (its name differs across versions: `SID`, `QBT_SID_<port>`). mangarr logs in again when a call gets a 403. When qBittorrent skips authentication for mangarr's subnet, there is no cookie and none is needed.
- **Category:** before each add, `GET /api/v2/torrents/categories`, then `POST /api/v2/torrents/createCategory` if the category is missing.
- **Adding a torrent:** `POST /api/v2/torrents/add` with the `.torrent` file (or the magnet link) and the category.
- **Polling:** `GET /api/v2/torrents/info?hashes=<h1|h2|…>` every poll interval, for the downloads being watched. Asking by hash rather than by category means a torrent moved to another category is still found.
- **Import:** `GET /api/v2/torrents/files?hash=` lists the files in the torrent, relative to its `save_path`.
- **Complete** means `amount_left === 0`, `progress === 1` (a magnet still fetching its metadata also has nothing left), and a state that isn't `checking*`, `metaDL`, `moving`, `missingFiles` or `error`.
- **Torrents mangarr didn't grab** are ignored, even in its own category.
- **Torrents that disappear** before import set the download to `missing_from_client`. If one shows up again, the download goes back to `downloading`.
- **Sessions:** one client per set of settings, so the poller and the Activity screen don't log in on every call.
- **mangarr never deletes or pauses torrents.** Seeding and cleanup are up to you (or qBittorrent's ratio and time limits).

### 6.3 Komga

- **Authentication:** a Komga API key (Komga ≥ 1.20) in the `X-API-Key` header. Scanning needs the key's user to be an admin.
- **Scan:** after a poll tick's imports, `POST /api/v1/libraries/{komgaLibraryId}/scan` once for each library that got new volumes, however many series in it did.
- If Komga isn't configured, or the language has no `komgaLibraryId`, the call is skipped. If the call fails, it's logged as a warning and doesn't affect the import. The error is also kept on each language using that library (`komgaScanError`), since there is no logs page. A scan that fails while Komga is down is not retried: Komga's own scheduled scan picks the files up.
- **Connection test:** `GET /api/v1/libraries`, which also fills the library picker for each language, then `GET /api/v2/users/me`. The test says whether the key can scan (its user has the `ADMIN` role).
- **Saving a language** with a library, or changing its root folder, runs `GET /api/v1/libraries/{id}`:
  - An unknown library is refused.
  - A root folder outside the library's folder (`root`) is saved, with a warning: Komga would scan but never see the imports.
  - If Komga isn't set up or can't be reached, the language is saved with a warning that the library wasn't checked.
- mangarr reads nothing else from Komga.

### 6.4 MangaBaka (REST API, no dump in v0)

- **Search** when adding a series.
- **Fetch the series record**: titles with language and traits, authors and artists, cover, status, `final_volume`, publishers by language, external IDs.
- **Collections endpoint** (beta, `/v1/series/{id}/collections`): pre-fills the volume count from the collection whose language matches, when there is one: the Standard Edition if present, with its largest count (digital often runs ahead of print). Otherwise `final_volume` (the original-language count) is used. In practice MangaBaka has collections for English only.
- **Rate limits:** search is 30/min and everything else 180/min (per IP). Debounce search input in the UI. On a 429, honour `Retry-After`.
- **Credit:** attribution goes on the About page. Data is for personal, non-commercial use.
- The endpoint list is in the OpenAPI spec at `https://mangabaka.org/api.json`.

### 6.5 Manga-News dataset (CSV)

- **Source:** a third-party dataset on data.gouv.fr (licence ODbL). It has about 11.7k series with the French publisher and the number of volumes published. It is not updated regularly.
- **File:** one UTF-8 CSV (about 3 MB), with columns `site_id, url, title, letter, publisher, volumes, artists, writers, genres, cover_url, first_seen_at, last_seen_at`. Columns are found by name, and `genres` is split on `|`. Spin-offs and editions are rows of their own (`Berserk - Roman`).
- **Settings:** the CSV URL plus a **"Refresh dataset"** button. There is no scheduled refresh.
- **Refresh** downloads the file and replaces the `MangaNewsSeries` table in one transaction:
  - Rows are matched by `site_id`, so series links are kept.
  - Linked series whose count came from Manga-News (`source = manganews`) get the new count, unless the row is back at 0.
  - A series whose row is gone loses the link. Its count stays, as a `manual` one.
  - A file that isn't the CSV (missing columns, no usable rows, not UTF-8) is refused, and the current table is kept.
- **Search:** every word of the query must appear in the title, as typed so far. The same title comes first, then titles that start with the query, then the rest, each by most volumes, so the main series usually comes before its spin-offs.
- **Add-series flow:** for languages with `useMangaNewsDataset`, you search the table by title and **pick the matching row by hand**. That sets `publisher` and `volumeCount` (`source = manganews`; a row with 0 volumes leaves the count alone). You can still edit both afterwards, and link, change or remove the row from the series page.
- **MangaBaka refresh** leaves the publisher of a linked series alone, since Manga-News knows French publishers better.
- **No automatic matching** between Manga-News and MangaBaka.
- **Credit:** attribution goes on the About page.

---

## 7. Flows

### 7.1 Add series

1. Search MangaBaka by title, then pick a result.
2. Choose the **Language**.
3. Review the **search terms**, **aliases** and **authors** (all pre-filled), and choose the **display title**.
4. **Folder:**
   - The default is `<rootFolder>/<sanitized displayTitle>`.
   - If that folder exists, it is adopted.
   - Otherwise, an existing folder in the root whose name reads as one of the series' search terms or aliases (as `titleMatch()` compares names), and that no other series uses, is proposed instead (`Frieren` for *Frieren: Beyond Journey's End*).
   - You can pick a different existing folder under the language root instead.
5. If `useMangaNewsDataset` is set, optionally link a Manga-News row.
6. Save. mangarr immediately runs a **disk scan** (§7.5).

### 7.2 Interactive search

Search covers a whole series only. There is no per-volume search.

1. For each search term of kind `search` (aliases are never queried), query Prowlarr with the language's indexers.
2. Remove duplicates by `infoHash`, falling back to `guid`, keeping the copy with the most seeders. Usenet results are dropped, since qBittorrent is the only download client.
3. Parse each title. **Drop chapter releases completely**; there is no toggle to show them.
4. Annotate each result with:
   - the volumes it covers
   - **covers a missing volume** (yes/no): it has a volume the series doesn't own, even one beyond `volumeCount` (digital often runs ahead). A complete pack with no numbers counts when volumes are missing or `volumeCount` is unknown.
   - **title match**: `exact`, `partial` or `none`, from `titleMatch()` (§5.3) against all of the series' search terms and aliases and its authors
   - its language, which comes from the Language whose indexers returned it, never from the release name
5. Sort by title match (exact, then partial, then none), then covers-missing, then seeders, all descending. A toggle hides results with no title match.
6. Show the title match, size, seeders, indexer, group, edition hint, and a **Grab** button. Grab works whatever the title match is; you decide.
7. On a `partial` or `none` result, an **Add alias** action saves that result's parsed title as an alias, so the next search matches it exactly. It is a UI shortcut for the existing add-search-term procedure.

Results never include Prowlarr's `downloadUrl` or `magnetUrl`: both are links to Prowlarr's proxy with its API key in them.

### 7.3 Grab

Grab takes a result's `guid`. The server keeps each series' latest search results in memory for 30 minutes (a new search replaces them), since the links never reach the UI. After that, or after a restart, you search again.

1. Get the torrent through Prowlarr's proxy, from `magnetUrl` when there is one, otherwise from `downloadUrl`. Redirects are followed by hand:
   - A redirect to a `magnet:` link: read the hash from it (`xt=urn:btih:`, hex or base32).
   - Otherwise the answer is the `.torrent`: compute the **v1 info-hash** (SHA-1 of the bencoded `info` dictionary). Hybrid torrents use their v1 hash; v2-only torrents and magnets are not supported in v0.
2. Refuse the grab if a Download already has that hash, or if qBittorrent already has the torrent (added by hand, say): mangarr only tracks torrents it adds.
3. Upload it to qBittorrent with the mangarr category.
4. Create a Download record (`downloading`) with the `expectedVolumes` from the parser and the result's `titleMatch`.

The mangarr server always fetches the torrent itself, never qBittorrent, so the info-hash is always known. Search results say which releases the series has already grabbed.

### 7.4 Poll and import

1. Every poll interval, ask qBittorrent about the `downloading` (and `missing_from_client`) Downloads by hash.
2. When a download is complete, set it to `importing`. Imports run **one at a time**, in the same tick, oldest first. A download left `importing` (by a crash, or because qBittorrent failed mid-import) is imported again on the next tick. The series folder is scanned first, so "owned" reflects the disk.
3. List the files in the torrent and keep `.cbz`, `.zip` and `.cbr`.
   - Any other extension (`.epub`, `.pdf`, `.rar`, images) is logged as `skipped_format`.
   - If no supported files are left, set `needs_attention`.
4. Parse each filename to get its volume number.
   - If there is **exactly one** supported file with no number, and the release title names a single volume, use that volume.
   - Files that still have no number are logged as `skipped_unparseable`.
5. For each volume found:
   - If it's already owned, log `skipped_owned` (the existing file is kept and never overwritten).
   - Otherwise **copy** the file to `<folderPath>/<displayTitle> v<NN>.<ext>`. The extension `.zip` becomes `.cbz`.
   - The copy is written to a temporary name in the destination folder, then renamed, so it's atomic.
   - The series folder is created if it's missing.
6. If at least one volume was imported: set `imported`, rescan the series folder, and trigger the Komga scan.
7. If nothing was imported (nothing matched, or every volume was already owned): set `needs_attention` with the reason.
8. **Retry import** in the Activity screen runs steps 2–7 again for a `needs_attention` download, right away. Each attempt replaces the previous import log, which lists the files in torrent order.

Copying is behind an **import strategy** interface, so a hardlink-first strategy can be added in v1 without changing the flow.

### 7.5 Disk scan

- **When it runs:** when a series is added, after each import, from the series page's **Rescan** button, and once for every series at startup. There is no scheduled scan and no file watching.
- **What it does:** lists `.cbz` and `.cbr` files directly in `folderPath`, parses each filename, and replaces that series' Volume rows.
- **Files it can't parse,** and duplicate volume numbers, appear as warnings on the series page. A file that names a chapter, no volume, or several volumes is not a volume. For a duplicate number, the first file by name is kept.
- A series folder that doesn't exist yet is not a warning: the first import creates it.

### 7.6 Naming

- Format: `<displayTitle> v<NN>.<ext>`.
- Padding is 2 digits, or 3 when `volumeCount` is at least 100 or any owned number is at least 100.
- Decimals stay as they are (`v10.5`).
- Characters that are illegal in filenames are replaced in folder and file names.

---

## 8. API and auth

- **oRPC.** The server defines one router of procedures, with inputs validated by Zod. The same router is served two ways:
  - **`/rpc`**: oRPC's RPC protocol, for the SPA. The client is typed from the router's type, so there is no codegen. Data fetching in the UI goes through TanStack Query (`@orpc/tanstack-query`).
  - **`/api/v1`**: REST, using the `.route()` method and path declared on each procedure, for scripts and homelab dashboards. The OpenAPI spec generated from the router is served at `/api/v1/openapi.json`, without a key, since it holds no data. Path and query parameters are coerced to the types the schema expects.
- **Every procedure declares a REST route**, so anything the UI can do can also be done over REST.
- **Every API call** on `/rpc` and `/api/v1` needs one of two credentials, checked by an oRPC middleware:
  - **a session cookie**, which is how the UI signs in;
  - **the mangarr API key** in the `X-Api-Key` header, for scripts and dashboards. The UI never uses it.
- **Public procedures:** `auth.status`, `auth.setup` and `auth.login`. The OpenAPI spec is public too.
- **First start:** while no user exists, the UI shows a setup screen that creates the account (username, and a password of at least 8 characters) and signs in. `auth.setup` refuses once a user exists.
- **Login:** a username and password. A failed login gives the same error whether or not the username exists, and takes about as long.
- **The session cookie** (`mangarr_session`) holds a random 32-byte token. It is `HttpOnly`, `SameSite=Strict` and `Path=/`, lasts 30 days, and is `Secure` when the request came over HTTPS (directly, or `X-Forwarded-Proto: https` from a reverse proxy). Logout deletes the session. Changing the password signs out every other session.
- **Cross-site requests:** `SameSite=Strict` keeps the cookie off requests from other sites, but other apps on subdomains of the same domain count as the same site. So every request without the API key, public procedures included, is refused (403) when `Sec-Fetch-Site` is anything but `same-origin` or `none`, or, when a browser sends no `Sec-Fetch-Site`, when `Origin` doesn't match `Host`. API-key requests skip this check, since browsers don't attach the key on their own.
- **Forgot the password:** `bun run auth:reset` (in the container: `docker exec -w /app/mangarr mangarr bun run auth:reset`) deletes the user and every session, so the next visit shows the setup screen again.
- **Secrets are write-only.** The settings procedures never return the Prowlarr or Komga API keys or the qBittorrent password, only whether each one is set. The mangarr API key is returned, so the Settings screen can show it for scripts.
- **Connection tests never send a saved secret to a new URL.** The Prowlarr, qBittorrent and Komga tests use the saved key or password only with the saved URL. To test another URL, the request must include the secret too. Otherwise anyone able to call the API could point a test at their own server and receive the saved key.

---

## 9. Screens

1. **Series list**: a grid of covers, with a language filter and owned/total counts.
2. **Add series**: the flow in §7.1.
3. **Series detail**:
   - a grid of volumes marked owned, missing or downloading
   - editable search terms, aliases, authors, display title and volume count
   - Search, Rescan and Refresh metadata buttons
   - warnings from the disk scan
4. **Interactive search**: a modal showing the results described in §7.2.
5. **Activity**: active downloads with progress, recent imports with their import log, and `needs_attention` items with a **Retry import** button.
6. **Settings**, split into categories as in Sonarr, each its own page under `/settings` and listed under Settings in the navigation: **Languages** (with the warnings from saving one, and the last Komga scan error), **Indexers** (Prowlarr, with a connection test), **Download Clients** (qBittorrent, with a connection test), **Connect** (Komga, with a connection test that says whether the key can scan), **Metadata** (the Manga-News dataset) and **General** (the API key, and changing the password).
7. **About**: version, plus credits for MangaBaka and Manga-News.
8. **Setup** (first start only) and **Login**: full-page forms, outside the app's navigation. The header has a **Sign out** button.

There is no calendar, no notifications, no history page beyond Activity, and no logs page.

---

## 10. Non-goals for v0 (the v1 backlog, in priority order)

1. **Bulk library import:** scan a language root and suggest series for the existing folders.
2. **Hardlink import** strategy, falling back to copy, with a UI warning when it falls back.
3. qBittorrent **file priorities**, so volumes you already own in a pack aren't downloaded.
4. A **screen to map files to volumes by hand** for downloads that need attention.
5. **RSS monitoring and automatic grabbing**, with quality and release preferences.
6. **Upgrades:** replacing a scan with a digital release.
7. **Conversion** of `.cbr` and image folders to `.cbz`, and support for `.epub`, `.pdf` and `.rar`.
8. **Notifications.**
9. **Download clients** other than qBittorrent.
10. **Remote path mappings.**
11. **Scheduled metadata refresh**, or using the MangaBaka dump.
12. **Matching Manga-News to MangaBaka automatically.**
13. **More than one user**, and limiting repeated failed logins.

Also out of scope: writing metadata into archives (`ComicInfo.xml`). Metadata stays the job of Komga and external tools.

---

## 11. Open decisions

None at the moment. Settled: the UI uses **Mantine** for components and **TanStack Router** for routing (code-based route tree, no codegen).

---

## 12. Suggested build order

1. **Parser:** collect the fixtures, then write `release-parser` until they pass.
2. **Server skeleton:** SQLite, Settings, Languages, and the Prowlarr client, with a script that prints parsed search results.
3. **Series:** the MangaBaka client, the add-series flow, and the disk scan.
4. **Grab:** fetching torrents and computing the hash, the qBittorrent client, and Download records.
5. **Poller and import engine**, plus the Activity screen.
6. **Komga scan**, and loading the Manga-News dataset.
7. **Docker image** and a real run on the server.

---

## 13. Notes

- **Komf removed its Nautiljon provider** (2026-08-21) after Nautiljon's owners objected to scraping. French metadata enrichment for Komga will need a new source. The Manga-News link stored on each series could later feed a small French metadata feature.
- **MangaBaka has little French data:** French publishers and editions are often missing. That's why French volume counts come from Manga-News or are entered by hand.
