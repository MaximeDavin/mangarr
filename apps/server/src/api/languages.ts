// Language procedures (spec §4.1).

import { posix } from "node:path";
import { ORPCError } from "@orpc/server";
import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { languages, series } from "../db/schema";
import { errorMessage } from "../errors";
import { KomgaError, komgaFromSettings } from "../integrations/komga";
import { listFolders, usedFolders } from "../library/folders";
import { normalizePath } from "../library/paths";
import { authed } from "./base";

const id = z.int().positive();

const languageOutput = z.object({
  id,
  code: z.string(),
  name: z.string(),
  prowlarrIndexerIds: z.array(z.int()),
  prowlarrCategories: z.array(z.int()),
  rootFolder: z.string(),
  komgaLibraryId: z.string().nullable(),
  /** Why the last Komga scan after an import failed, until one works. */
  komgaScanError: z.string().nullable(),
  komgaScanErrorAt: z.date().nullable(),
  useMangaNewsDataset: z.boolean(),
});

/** Create and update also say what the Komga check found (see `checkKomgaLibrary`). */
const savedOutput = languageOutput.extend({ warnings: z.array(z.string()) });

const languageFields = z.object({
  /** Lowercase language tag such as `en`, `fr` or `pt-br`. */
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/, "Use a language code such as en, fr or pt-br"),
  name: z.string().trim().min(1),
  prowlarrIndexerIds: z.array(id),
  /** Empty means all categories. */
  prowlarrCategories: z.array(id),
  /** A path inside the container (spec §3), so POSIX rules apply whatever OS runs the server. */
  rootFolder: z.string().trim().refine(posix.isAbsolute, "Must be an absolute path").transform(normalizePath),
  /** null (or "") means no Komga scan after imports. */
  komgaLibraryId: z
    .string()
    .trim()
    .nullable()
    .transform((value) => value || null),
  useMangaNewsDataset: z.boolean(),
});

const s = languageFields.shape;
const createInput = languageFields.extend({
  prowlarrIndexerIds: s.prowlarrIndexerIds.default([]),
  prowlarrCategories: s.prowlarrCategories.default([]),
  komgaLibraryId: s.komgaLibraryId.default(null),
  useMangaNewsDataset: s.useMangaNewsDataset.default(false),
});
// No defaults here (Zod applies them even to omitted optional fields), so omitted fields keep their value.
const updateInput = languageFields.partial().extend({ id });

const notFound = (languageId: number) => new ORPCError("NOT_FOUND", { message: `Language ${languageId} not found` });

/** The language, or a NOT_FOUND error. */
export function getLanguage(db: Db, languageId: number) {
  const row = db.select().from(languages).where(eq(languages.id, languageId)).get();
  if (!row) throw notFound(languageId);
  return row;
}

function assertCodeFree(db: Db, code: string, exceptId?: number) {
  const clash = db
    .select({ id: languages.id })
    .from(languages)
    .where(
      exceptId === undefined ? eq(languages.code, code) : and(eq(languages.code, code), ne(languages.id, exceptId)),
    )
    .get();
  if (clash) throw new ORPCError("CONFLICT", { message: `A language with code "${code}" already exists` });
}

/** True when `folder` is `root` or inside it. Both are container (POSIX) paths. */
function within(root: string, folder: string): boolean {
  const base = normalizePath(root).replace(/\/$/, "");
  const path = normalizePath(folder);
  return base === "" || path === base || path.startsWith(`${base}/`);
}

/**
 * Checks a language's Komga library before it is saved: an unknown library is refused, since
 * every scan would fail. What can't be checked, and a root folder outside the library's folder
 * (Komga would scan but never see the imports), are warnings: the language is saved anyway.
 */
async function checkKomgaLibrary(
  db: Db,
  libraryId: string,
  rootFolder: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let library: { name: string; root: string };
  try {
    library = await komgaFromSettings(db).library(libraryId, signal);
  } catch (error) {
    if (error instanceof KomgaError && error.kind === "not_found") {
      throw new ORPCError("BAD_REQUEST", { message: `Komga has no library ${libraryId}`, cause: error });
    }
    if (error instanceof KomgaError && error.kind === "not_configured") {
      return [`Komga isn't set up yet, so library ${libraryId} wasn't checked`];
    }
    return [`Could not check the Komga library: ${errorMessage(error)}`];
  }
  if (within(library.root, rootFolder)) return [];
  return [
    `The root folder ${rootFolder} is not inside the Komga library "${library.name}" (${library.root}), so Komga won't see imported volumes. Both containers must use the same paths.`,
  ];
}

const tags = ["Languages"];

export const languagesRouter = {
  list: authed
    .route({ method: "GET", path: "/languages", summary: "List languages", tags })
    .output(z.array(languageOutput))
    .handler(({ context }) => context.db.select().from(languages).orderBy(languages.name).all()),

  get: authed
    .route({ method: "GET", path: "/languages/{id}", summary: "Get a language", tags })
    .input(z.object({ id }))
    .output(languageOutput)
    .handler(({ context, input }) => getLanguage(context.db, input.id)),

  create: authed
    .route({ method: "POST", path: "/languages", summary: "Add a language", tags, successStatus: 201 })
    .input(createInput)
    .output(savedOutput)
    .handler(async ({ context, input, signal }) => {
      assertCodeFree(context.db, input.code);
      const warnings = input.komgaLibraryId
        ? await checkKomgaLibrary(context.db, input.komgaLibraryId, input.rootFolder, signal)
        : [];
      return { ...context.db.insert(languages).values(input).returning().get(), warnings };
    }),

  update: authed
    .route({
      method: "PATCH",
      path: "/languages/{id}",
      summary: "Update a language",
      description:
        "Omitted fields keep their value. A new Komga library or root folder is checked against Komga first (see create); a new library also clears the last scan error.",
      tags,
    })
    .input(updateInput)
    .output(savedOutput)
    .handler(async ({ context, input: { id: languageId, ...changes }, signal }) => {
      const current = getLanguage(context.db, languageId);
      if (changes.code !== undefined) assertCodeFree(context.db, changes.code, languageId);

      const libraryId = changes.komgaLibraryId === undefined ? current.komgaLibraryId : changes.komgaLibraryId;
      const rootFolder = changes.rootFolder ?? current.rootFolder;
      const libraryChanged = libraryId !== current.komgaLibraryId;
      const warnings =
        libraryId && (libraryChanged || rootFolder !== current.rootFolder)
          ? await checkKomgaLibrary(context.db, libraryId, rootFolder, signal)
          : [];

      const set: Partial<typeof languages.$inferInsert> = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      );
      if (libraryChanged) Object.assign(set, { komgaScanError: null, komgaScanErrorAt: null });
      // Drizzle refuses a `set` with nothing in it (form state often carries explicit undefineds).
      const row =
        Object.keys(set).length === 0
          ? current
          : context.db.update(languages).set(set).where(eq(languages.id, languageId)).returning().get()!;
      return { ...row, warnings };
    }),

  folders: authed
    .route({
      method: "GET",
      path: "/languages/{id}/folders",
      summary: "List the folders in a language's root",
      description: "For choosing an existing folder when adding a series. Empty when the root doesn't exist yet.",
      tags,
    })
    .input(z.object({ id }))
    .output(
      z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          /** The series already using this folder. */
          seriesId: id.nullable(),
        }),
      ),
    )
    .handler(async ({ context, input }) => {
      const language = getLanguage(context.db, input.id);
      const used = usedFolders(context.db, language.id);
      const folders = await listFolders(language.rootFolder);
      return folders.map((folder) => ({ ...folder, seriesId: used.get(folder.path) ?? null }));
    }),

  delete: authed
    .route({
      method: "DELETE",
      path: "/languages/{id}",
      summary: "Delete a language",
      description: "Refused while the language still has series.",
      tags,
      successStatus: 204,
    })
    .input(z.object({ id }))
    .handler(({ context, input }) => {
      const used = context.db.select({ n: count() }).from(series).where(eq(series.languageId, input.id)).get();
      if (used && used.n > 0) {
        throw new ORPCError("CONFLICT", { message: `This language still has ${used.n} series` });
      }
      const deleted = context.db.delete(languages).where(eq(languages.id, input.id)).returning().get();
      if (!deleted) throw notFound(input.id);
    }),
};
