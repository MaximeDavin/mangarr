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

- **One Docker image** serves both the GraphQL API and the built React UI on a single port. Pick a default port that doesn't clash with other *arr apps.
- **Volumes:**
  - `/config` holds the SQLite database.
  - `/data` is the same mount that qBittorrent and Komga see, e.g. `/data/torrents` and `/data/media/manga/{en,fr}`. mangarr assumes **the same paths in every container**, with no remote path mapping in v0.
- **Environment variables** cover infrastructure only: `PORT`, `PUID`, `PGID`, `TZ`, and optionally `CONFIG_DIR`. Everything else (URLs, API keys, languages) is set in the UI and stored in SQLite.
- **Logs** go to stdout/stderr, for `docker logs`.
- **Runtime:** Node 22 LTS, TypeScript, SQLite.
- **Background work** runs as an in-process job loop. There is no Redis and no external queue.

### 3.1 Repository layout (pnpm monorepo)

```
apps/
  server/            # GraphQL API, job loop, integrations, serves web build
  web/               # Vite + React SPA
packages/
  release-parser/    # pure parsing lib + fixture-driven tests
docs/
  spec-v0.md
```

---

## 4. Data model

The ORM is still an open decision. The shapes below don't depend on that choice.

### 4.1 Language

| Field | Notes |
|---|---|
| `id` | |
| `code` | e.g. `en`, `fr`. Unique. |
| `name` | Display name. |
| `prowlarrIndexerIds` | `int[]`. Which Prowlarr indexers to search for this language. |
| `prowlarrCategories` | `int[]`, optional, empty by default (all categories). |
| `rootFolder` | e.g. `/data/media/manga/fr`. |
| `komgaLibraryId` | Nullable. When null, no Komga scan is triggered. |
| `useMangaNewsDataset` | `bool`. When true, the add-series flow offers to link a Manga-News row (see §6.5). In practice this is on for `fr` only, but the code never checks the code. |

### 4.2 Series

| Field | Notes |
|---|---|
| `id` | |
| `languageId` | FK. Each series belongs to exactly one language. |
| `mangabakaId` | Main external ID. |
| `externalIds` | JSON with AniList, MAL and MangaUpdates IDs, copied from MangaBaka. |
| `displayTitle` | Used for the folder and file names. Chosen from the search terms when the series is added. |
| `folderPath` | Absolute path. Defaults to `<rootFolder>/<displayTitle>`, or an existing folder you pick. |
| `coverUrl`, `status`, `publisher` | Cached from MangaBaka (and from Manga-News for the publisher, when linked). |
| `volumeCount` | Nullable, editable. Only used to show which volumes are missing. |
| `volumeCountSource` | `mangabaka`, `manganews` or `manual`. |
| `mangaNewsSeriesId` | Nullable FK to the Manga-News row. |
| `metadataJson`, `metadataFetchedAt` | Cached MangaBaka record. Refreshed on demand. |
| `lastScannedAt` | |

### 4.3 SearchTerm

`id`, `seriesId`, `term`. Prefilled from MangaBaka titles in the series language, plus the romaji and native titles. Fully editable.

### 4.4 Volume (owned files only)

| Field | Notes |
|---|---|
| `id`, `seriesId` | |
| `number` | Decimal. Unique per series. |
| `filePath`, `fileSize`, `format` | `cbz` or `cbr`. |
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
| `expectedVolumes` | From parsing the release title. May be "unknown" for `Complete` packs. |
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

The table holds rows imported from the Manga-News CSV: title, French publisher, number of volumes published, first and last dates, plus `datasetImportedAt`. The exact columns get mapped once the real CSV is in hand.

### 4.8 Settings (key/value)

- Prowlarr: URL and API key.
- qBittorrent: URL, username, password, category (default `mangarr`).
- Komga: URL and API key.
- Manga-News CSV URL.
- Poll interval (default 30 s).
- mangarr API key: generated on first start, and can be regenerated.

---

## 5. Release parser (`packages/release-parser`)

A pure function with no I/O. Imports use the **same parser** on filenames.

```ts
parse(input: string): {
  title: string;              // cleaned series title
  volumes: number[] | "unknown" | null; // [] never; null = no volume info
  isChapterRelease: boolean;
  group?: string;             // e.g. "1r0n"
  editionHint?: string;       // Perfect, Deluxe, Kanzenban, Omnibus, 3-in-1, Intégrale…
  source?: "digital" | "scan";
  extension?: "cbz" | "zip" | "cbr" | string;
}
```

### 5.1 Patterns it must handle

- **Volume markers:**
  - `v01`, `v1`, `Vol. 3`, `Vol 3`, `Volume 03`
  - `T01` and `Tome 1` (the French convention)
  - decimals (`v10.5`)
- **Ranges:**
  - `v01-20`, `v01-v20`, `Vol. 1-12`, `T01-T12`, `Tome 1-12`
  - Ranges are expanded into the `volumes` list.
- **Packs:**
  - `Complete`, `Intégrale` and similar with no numbers give `volumes: "unknown"`.
  - The real volumes are worked out from the files at import time.
- **Chapter markers** (`c001`, `c001-010`, `Ch.`, `Chapter`, `Chapitre`) set `isChapterRelease`, unless volume markers are also present.
- **Groups and tags:**
  - A leading `[Group]` becomes `group`.
  - `(Digital)` and similar set `source`.
  - Trailing `(…)` and `[…]` tags are stripped from `title`.
- **Normalization for title matching** (§7.2): lowercase, strip diacritics, drop punctuation, collapse whitespace.

### 5.2 Tests

Tests are fixture-driven (Vitest, or whatever runner you choose):

- Files such as `fixtures/nyaa.json` and `fixtures/fr-tracker.json` hold `{ input, expected }` pairs.
- **Start with about 50 real titles per indexer, copied before writing any parser code.**
- Every unparseable filename found in an import log becomes a new fixture.

---

## 6. Integrations

### 6.1 Prowlarr (search only)

- **Search:** `GET /api/v1/search` with `query`, the Language's `indexerIds`, optional `categories`, and the `X-Api-Key` header.
- **Settings screen:** `GET /api/v1/indexer` fills the indexer picker for each language.
- **Fields used from each result:** `guid`, `title`, `size`, `seeders`, `leechers`, `indexer`, `downloadUrl`, `magnetUrl`, `infoHash`, `publishDate`.
- mangarr does **not** register as a Prowlarr "Application".

### 6.2 qBittorrent (Web API v2)

- **Authentication:** `POST /api/v2/auth/login` gives a session cookie. mangarr logs in again when the cookie expires.
- **Category:** `POST /api/v2/torrents/createCategory` makes sure the category exists, either on startup or when settings are saved.
- **Adding a torrent:** `POST /api/v2/torrents/add` with the `.torrent` file (or the magnet link) and the category.
- **Polling:** `GET /api/v2/torrents/info?category=<cat>` every poll interval.
- **Import:** `GET /api/v2/torrents/files?hash=` lists the files in the torrent.
- **Complete** means `amount_left === 0` and the state is not one of the `checking*` states.
- **Torrents mangarr didn't grab** are ignored, even in its own category.
- **Torrents that disappear** before import set the download to `missing_from_client`.
- **mangarr never deletes or pauses torrents.** Seeding and cleanup are up to you (or qBittorrent's ratio and time limits).

### 6.3 Komga

- After a successful import: `POST /api/v1/libraries/{komgaLibraryId}/scan` with the Komga API key.
- If Komga isn't configured, or the language has no `komgaLibraryId`, the call is skipped. If the call fails, it's logged as a warning and doesn't affect the import.
- mangarr reads nothing from Komga.

### 6.4 MangaBaka (REST API, no dump in v0)

- **Search** when adding a series.
- **Fetch the series record**: titles with language and traits, cover, status, `final_volume`, publishers by language, external IDs.
- **Collections endpoint** (beta, `/v1/series/{id}/collections`): pre-fills the volume count from the collection whose language matches, when there is one.
- **Rate limits:** search is 30/min and everything else 180/min (per IP). Debounce search input in the UI. On a 429, honour `Retry-After`.
- **Credit:** attribution goes on the About page. Data is for personal, non-commercial use.
- The endpoint list is in the OpenAPI spec at `https://mangabaka.org/api.json`.

### 6.5 Manga-News dataset (CSV)

- **Source:** a third-party dataset on data.gouv.fr (licence ODbL). It has about 11.7k series with the French publisher and the number of volumes published. It is not updated regularly.
- **Settings:** the CSV URL plus a **"Refresh dataset"** button that downloads the file and replaces the `MangaNewsSeries` table. There is no scheduled refresh.
- **Add-series flow:** for languages with `useMangaNewsDataset`, you search the table by title and **pick the matching row by hand**. That sets `volumeCount` (`source = manganews`) and `publisher`. You can still edit both afterwards.
- **No automatic matching** between Manga-News and MangaBaka.
- **Credit:** attribution goes on the About page.

---

## 7. Flows

### 7.1 Add series

1. Search MangaBaka by title, then pick a result.
2. Choose the **Language**.
3. Review the **search terms** (pre-filled) and choose the **display title**.
4. **Folder:**
   - The default is `<rootFolder>/<sanitized displayTitle>`.
   - If that folder exists, it is adopted.
   - You can pick a different existing folder under the language root instead.
5. If `useMangaNewsDataset` is set, optionally link a Manga-News row.
6. Save. mangarr immediately runs a **disk scan** (§7.5).

### 7.2 Interactive search

Search covers a whole series only. There is no per-volume search.

1. For each search term, query Prowlarr with the language's indexers.
2. Remove duplicates by `infoHash`, falling back to `guid`.
3. Parse each title. **Drop chapter releases completely**; there is no toggle to show them.
4. Annotate each result with:
   - the volumes it covers
   - **covers a missing volume** (yes/no)
   - **title match**: the normalized parsed title equals one of the normalized search terms
   - its language, which comes from the Language whose indexers returned it, never from the release name
5. Sort by title match, then covers-missing, then seeders, all descending. A toggle hides results that don't match the title.
6. Show the size, seeders, indexer, group, edition hint, and a **Grab** button.

### 7.3 Grab

1. Get the torrent:
   - With a magnet link, read the hash from it.
   - Otherwise fetch `downloadUrl` through Prowlarr's proxy. If it redirects to a `magnet:` link, use that.
   - Otherwise read the `.torrent` and compute the **v1 info-hash** (SHA-1 of the bencoded `info` dictionary). v2-only torrents are not supported in v0.
2. Upload it to qBittorrent with the mangarr category.
3. Create a Download record (`downloading`) with the `expectedVolumes` from the parser.

The mangarr server always fetches the torrent itself, never qBittorrent, so the info-hash is always known.

### 7.4 Poll and import

1. Every poll interval, list the torrents in the mangarr category and match them to `downloading` Downloads by hash.
2. When a download is complete, set it to `importing`. Imports run **one at a time**.
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
8. **Retry import** in the Activity screen runs steps 2–7 again for a `needs_attention` download.

Copying is behind an **import strategy** interface, so a hardlink-first strategy can be added in v1 without changing the flow.

### 7.5 Disk scan

- **When it runs:** when a series is added, after each import, from the series page's **Rescan** button, and once for every series at startup. There is no scheduled scan and no file watching.
- **What it does:** lists `.cbz` and `.cbr` files directly in `folderPath`, parses each filename, and replaces that series' Volume rows.
- **Files it can't parse,** and duplicate volume numbers, appear as warnings on the series page.

### 7.6 Naming

- Format: `<displayTitle> v<NN>.<ext>`.
- Padding is 2 digits, or 3 when `volumeCount` is at least 100 or any owned number is at least 100.
- Decimals stay as they are (`v10.5`).
- Characters that are illegal in filenames are replaced in folder and file names.

---

## 8. API and auth

- **GraphQL** on a single `/graphql` endpoint. The server, schema and client libraries are still open decisions.
- **No login screen in v0.** mangarr is expected to run on your LAN or behind your reverse proxy's authentication.
- **Every API call** needs the mangarr API key (`X-Api-Key` header).
- **The SPA gets the key** from a bootstrap script that the server injects, the way *arr apps do when auth is turned off. The key stops other sites and scripts from calling the API. It does **not** stop someone who can load the UI.

---

## 9. Screens

1. **Series list**: a grid of covers, with a language filter and owned/total counts.
2. **Add series**: the flow in §7.1.
3. **Series detail**:
   - a grid of volumes marked owned, missing or downloading
   - editable search terms, display title and volume count
   - Search, Rescan and Refresh metadata buttons
   - warnings from the disk scan
4. **Interactive search**: a modal showing the results described in §7.2.
5. **Activity**: active downloads with progress, recent imports with their import log, and `needs_attention` items with a **Retry import** button.
6. **Settings**: languages, Prowlarr (with a connection test), qBittorrent (with a connection test), Komga (with a connection test), Manga-News dataset, and the API key.
7. **About**: version, plus credits for MangaBaka and Manga-News.

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
8. A **login screen**.
9. **Notifications.**
10. **Download clients** other than qBittorrent.
11. **Remote path mappings.**
12. **Scheduled metadata refresh**, or using the MangaBaka dump.
13. **Matching Manga-News to MangaBaka automatically.**

Also out of scope: writing metadata into archives (`ComicInfo.xml`). Metadata stays the job of Komga and external tools.

---

## 11. Open decisions

| Decision | Options under consideration |
|---|---|
| ORM / database access | Drizzle, Prisma, Kysely, raw `better-sqlite3`… |
| GraphQL server | GraphQL Yoga, Apollo Server, with Pothos (code-first) or SDL-first |
| GraphQL client | Apollo Client, urql |
| UI component library | Mantine, shadcn/ui, … |
| Test runner | Vitest (assumed) |
| Default port | Any port not used by another *arr app |

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
