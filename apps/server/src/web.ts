// Serves the built React UI (apps/web/dist) on the API's port (spec §3).

import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * A file from the build, or index.html for any other page path, so client-side routes survive
 * a reload. Returns undefined when nothing matches.
 */
export async function serveWeb(webDir: string, pathname: string): Promise<Response | undefined> {
  const root = resolve(webDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const path = resolve(root, `.${decoded}`);
  if (path !== root && !path.startsWith(root + sep)) return undefined;

  if (await isFile(path)) {
    // Vite puts a content hash in every asset name, so those never change.
    const immutable = decoded.startsWith("/assets/");
    return new Response(Bun.file(path), {
      headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }

  // A missing file (/favicon.ico, an old asset) is a 404, not the app.
  if (extname(decoded) !== "") return undefined;

  const index = join(root, "index.html");
  if (!(await isFile(index))) {
    return new Response(
      "The web UI isn't built. Run `bun run build` in apps/web, or use the Vite dev server (`bun run dev` in apps/web).",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(Bun.file(index), { headers: { "cache-control": "no-cache" } });
}
