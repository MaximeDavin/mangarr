// Folder and file names in the library (spec §7.6), and path checks.
//
// Library paths are container paths (spec §3), stored with "/" separators. Windows paths, used
// while developing, work with "/" too, so they are stored the same way.

import { isAbsolute, relative, resolve } from "node:path";

/**
 * The one form library paths are stored and compared in: "/" separators, no repeated or trailing
 * ones. `C:\manga\en\` becomes `C:/manga/en`; `/` and `C:/` keep their slash.
 */
export function normalizePath(path: string): string {
  return path.replace(/[\\/]+/g, "/").replace(/([^:/])\/$/, "$1");
}

/**
 * Makes a display title safe as a folder or file name on every OS: drops control characters,
 * turns `:` into ` - ` and slashes and pipes into `-`, drops `<>"?*`, and trims trailing dots
 * and spaces (Windows refuses them). Can return "" for a title made only of such characters.
 */
export function sanitizeName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s*:\s*/g, " - ")
    .replace(/[\\/|]/g, "-")
    .replace(/[<>"?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
}

/** 2 digits, or 3 once the series reaches volume 100 (by its count or by a volume it owns). */
export function volumePadding(volumeCount: number | null, numbers: Iterable<number>): number {
  if ((volumeCount ?? 0) >= 100) return 3;
  for (const n of numbers) if (n >= 100) return 3;
  return 2;
}

/** `<displayTitle> v<NN>.<ext>`, e.g. `Berserk v07.cbz`, `Berserk v10.5.cbz`, `One Piece v105.cbz`. */
export function volumeFileName(displayTitle: string, number: number, extension: string, padding: number): string {
  const [whole, fraction] = String(number).split(".");
  const formatted = whole!.padStart(padding, "0") + (fraction ? `.${fraction}` : "");
  return `${sanitizeName(displayTitle)} v${formatted}.${extension}`;
}

/** `folder/name` with `folder` normalized. `name` is kept as is: a "\" is a valid character in a Linux file name. */
export function joinPath(folder: string, name: string): string {
  const base = normalizePath(folder);
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

/** True when `path` is strictly inside `root` (not `root` itself). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
