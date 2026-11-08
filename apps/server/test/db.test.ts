import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Db, migrationsFolder, openDatabase } from "../src/db/client";
import { downloads, languages, searchTerms, series, volumes } from "../src/db/schema";

/** Drizzle wraps driver errors, so the SQLite message (naming the failed constraint) is in `cause`. */
function sqliteError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return String(cause instanceof Error ? cause.message : error);
  }
  throw new Error("expected the statement to fail");
}

function seed(db: Db) {
  const language = db
    .insert(languages)
    .values({ code: "fr", name: "Français", rootFolder: "/data/media/manga/fr", prowlarrIndexerIds: [3, 7] })
    .returning()
    .get();
  const one = db
    .insert(series)
    .values({
      languageId: language.id,
      mangabakaId: 42,
      displayTitle: "One Piece",
      folderPath: "/data/media/manga/fr/One Piece",
      authors: ["Eiichiro Oda"],
      externalIds: { anilist: 30013 },
    })
    .returning()
    .get();
  return { language, series: one };
}

function addVolume(db: Db, seriesId: number, values: Partial<typeof volumes.$inferInsert> = {}) {
  db.insert(volumes)
    .values({ seriesId, number: 1, filePath: "/v01.cbz", fileSize: 1, format: "cbz", source: "scan", ...values })
    .run();
}

describe("openDatabase", () => {
  describe("a later migration", () => {
    /**
     * Copies the real migrations, creates a seeded database file in a folder that doesn't exist yet,
     * then adds `sql` as a new migration for `check` to apply by reopening the file.
     */
    function withExtraMigration(sql: (db: Db) => string, check: (path: string, migrations: string) => void) {
      const dir = mkdtempSync(join(tmpdir(), "mangarr-migrate-"));
      try {
        const migrations = join(dir, "drizzle");
        cpSync(migrationsFolder, migrations, { recursive: true });
        const path = join(dir, "nested", "mangarr.db");

        const db = openDatabase(path, migrations);
        const { series: row } = seed(db);
        db.insert(searchTerms).values({ seriesId: row.id, term: "One Piece", kind: "search" }).run();
        addVolume(db, row.id);
        const extra = sql(db);
        db.$client.close();

        mkdirSync(join(migrations, "20991231000000_extra"));
        writeFileSync(join(migrations, "20991231000000_extra", "migration.sql"), extra);
        check(path, migrations);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("can rebuild a parent table without deleting its children", () => {
      withExtraMigration(
        (db) => {
          // The same steps drizzle-kit writes when it has to recreate `series` to change a column.
          const create = db.$client
            .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'series'")
            .get()!
            .sql.replace("CREATE TABLE `series`", "CREATE TABLE `__new_series`");
          return [
            "PRAGMA foreign_keys=OFF;",
            `${create};`,
            "INSERT INTO `__new_series` SELECT * FROM `series`;",
            "DROP TABLE `series`;",
            "ALTER TABLE `__new_series` RENAME TO `series`;",
            "PRAGMA foreign_keys=ON;",
          ].join("--> statement-breakpoint\n");
        },
        (path, migrations) => {
          const db = openDatabase(path, migrations);
          expect(db.select().from(series).all()).toHaveLength(1);
          expect(db.select().from(volumes).all()).toHaveLength(1);
          expect(db.select().from(searchTerms).all()).toHaveLength(1);
          // Foreign keys are back on once migrations are done.
          expect(db.$client.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
          db.$client.close();
        },
      );
    });

    it("refuses to start when it leaves rows pointing at a missing parent", () => {
      withExtraMigration(
        () => "DELETE FROM `series`;",
        (path, migrations) => {
          expect(() => openDatabase(path, migrations)).toThrow(/missing parents/);
        },
      );
    });
  });
});

describe("schema", () => {
  it("round-trips JSON columns and applies defaults", () => {
    const db = openDatabase(":memory:");
    const { language, series: row } = seed(db);
    expect(language.prowlarrIndexerIds).toEqual([3, 7]);
    expect(language.prowlarrCategories).toEqual([]);
    expect(language.useMangaNewsDataset).toBe(false);
    expect(row.authors).toEqual(["Eiichiro Oda"]);
    expect(row.externalIds).toEqual({ anilist: 30013 });
  });

  it("stores decimal volume numbers and rejects a duplicate number in a series", () => {
    const db = openDatabase(":memory:");
    const { series: row } = seed(db);

    addVolume(db, row.id, { number: 10.5 });
    expect(db.select().from(volumes).get()?.number).toBe(10.5);
    expect(sqliteError(() => addVolume(db, row.id, { number: 10.5, filePath: "/y.cbz" }))).toBe(
      "UNIQUE constraint failed: volumes.series_id, volumes.number",
    );
  });

  it("rejects two volume rows for the same file", () => {
    const db = openDatabase(":memory:");
    const { series: row } = seed(db);

    addVolume(db, row.id);
    expect(sqliteError(() => addVolume(db, row.id, { number: 2 }))).toBe("UNIQUE constraint failed: volumes.file_path");
  });

  it("allows a manga once per language", () => {
    const db = openDatabase(":memory:");
    const { language } = seed(db);
    const en = db.insert(languages).values({ code: "en", name: "English", rootFolder: "/en" }).returning().get();
    const onePiece = { mangabakaId: 42, displayTitle: "One Piece" };

    db.insert(series)
      .values({ ...onePiece, languageId: en.id, folderPath: "/en/One Piece" })
      .run();
    expect(
      sqliteError(() =>
        db
          .insert(series)
          .values({ ...onePiece, languageId: language.id, folderPath: "/elsewhere" })
          .run(),
      ),
    ).toBe("UNIQUE constraint failed: series.language_id, series.mangabaka_id");
  });

  it("fills JSON and timestamp defaults in SQL, for inserts that bypass Drizzle", () => {
    const db = openDatabase(":memory:");
    const { series: row } = seed(db);
    const before = Date.now();
    db.$client.exec("INSERT INTO languages (code, name, root_folder) VALUES ('en', 'English', '/en')");
    db.$client.exec(
      `INSERT INTO downloads (series_id, info_hash, release_title, indexer_name, prowlarr_guid, size, title_match)
       VALUES (${row.id}, 'abc', 'One Piece Complete', 'nyaa', 'g', 1, 'exact')`,
    );

    const en = db.select().from(languages).where(eq(languages.code, "en")).get();
    expect(en?.prowlarrIndexerIds).toEqual([]);
    expect(en?.prowlarrCategories).toEqual([]);
    const download = db.select().from(downloads).get();
    expect(download?.expectedVolumes).toEqual([]);
    expect(download?.status).toBe("downloading");
    expect(download?.grabbedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(download?.grabbedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("rejects values outside an enum column, but still allows NULL in nullable ones", () => {
    const db = openDatabase(":memory:");
    const { series: row } = seed(db);
    expect(() =>
      db.$client.exec(
        `INSERT INTO volumes (series_id, number, file_path, file_size, format, source) VALUES (${row.id}, 1, '/x.pdf', 1, 'pdf', 'scan')`,
      ),
    ).toThrow("CHECK constraint failed: volumes_format_check");
    expect(() => db.$client.exec(`UPDATE series SET volume_count_source = 'guess' WHERE id = ${row.id}`)).toThrow(
      "CHECK constraint failed: series_volume_count_source_check",
    );
    // The seeded series has no volume count source, and NULL passes the check.
    expect(db.select().from(series).get()?.volumeCountSource).toBeNull();
  });

  it("indexes every foreign-key column", () => {
    const db = openDatabase(":memory:");
    const client = db.$client;
    const tables = client
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    const unindexed: string[] = [];
    for (const { name } of tables) {
      // Columns that lead an index (including UNIQUE constraints), so lookups on them can use it.
      const leading = new Set(
        client
          .query<{ name: string }, []>(`PRAGMA index_list(\`${name}\`)`)
          .all()
          .map((idx) => client.query<{ name: string }, []>(`PRAGMA index_info(\`${idx.name}\`)`).get()?.name),
      );
      for (const fk of client.query<{ from: string }, []>(`PRAGMA foreign_key_list(\`${name}\`)`).all()) {
        if (!leading.has(fk.from)) unindexed.push(`${name}.${fk.from}`);
      }
    }
    expect(unindexed).toEqual([]);
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db.insert(series).values({ languageId: 999, mangabakaId: 1, displayTitle: "X", folderPath: "/x" }).run(),
    ).toThrow();
  });

  it("deletes a series' volumes and search terms with it", () => {
    const db = openDatabase(":memory:");
    const { series: row } = seed(db);
    db.insert(searchTerms).values({ seriesId: row.id, term: "One Piece", kind: "search" }).run();
    addVolume(db, row.id);

    db.delete(series).where(eq(series.id, row.id)).run();
    expect(db.select().from(volumes).all()).toHaveLength(0);
    expect(db.select().from(searchTerms).all()).toHaveLength(0);
  });

  it("loads a series with its language and volumes through the relational API", () => {
    const db = openDatabase(":memory:");
    const { series: row } = seed(db);
    addVolume(db, row.id);

    const found = db.query.series.findFirst({ with: { language: true, volumes: true } }).sync();
    expect(found?.language.code).toBe("fr");
    expect(found?.volumes.map((v) => v.number)).toEqual([1]);
  });
});
