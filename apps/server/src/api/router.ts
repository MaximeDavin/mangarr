// The one oRPC router, served as RPC on /rpc and as REST on /api/v1 (spec §8).
// Every procedure must declare a REST route with `.route()`.

import { authRouter } from "./auth";
import { downloadsRouter } from "./downloads";
import { komgaRouter } from "./komga";
import { languagesRouter } from "./languages";
import { mangabakaRouter } from "./mangabaka";
import { mangaNewsRouter } from "./manganews";
import { prowlarrRouter } from "./prowlarr";
import { qbittorrentRouter } from "./qbittorrent";
import { releasesRouter } from "./releases";
import { seriesRouter } from "./series";
import { settingsRouter } from "./settings";

export const router = {
  auth: authRouter,
  settings: settingsRouter,
  languages: languagesRouter,
  prowlarr: prowlarrRouter,
  qbittorrent: qbittorrentRouter,
  komga: komgaRouter,
  mangabaka: mangabakaRouter,
  mangaNews: mangaNewsRouter,
  series: seriesRouter,
  releases: releasesRouter,
  downloads: downloadsRouter,
};

/** The SPA builds its typed client from this type. */
export type Router = typeof router;
