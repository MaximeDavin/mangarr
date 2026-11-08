// Relations for the relational query API (`db.query.series.findMany({ with: { volumes: true } })`).

import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  languages: {
    series: r.many.series(),
  },
  series: {
    language: r.one.languages({ from: r.series.languageId, to: r.languages.id, optional: false }),
    mangaNews: r.one.mangaNewsSeries({ from: r.series.mangaNewsSeriesId, to: r.mangaNewsSeries.id }),
    searchTerms: r.many.searchTerms(),
    volumes: r.many.volumes(),
    downloads: r.many.downloads(),
  },
  mangaNewsSeries: {
    series: r.many.series(),
  },
  searchTerms: {
    series: r.one.series({ from: r.searchTerms.seriesId, to: r.series.id, optional: false }),
  },
  volumes: {
    series: r.one.series({ from: r.volumes.seriesId, to: r.series.id, optional: false }),
  },
  downloads: {
    series: r.one.series({ from: r.downloads.seriesId, to: r.series.id, optional: false }),
    importLog: r.many.importLogEntries(),
  },
  importLogEntries: {
    download: r.one.downloads({
      from: r.importLogEntries.downloadId,
      to: r.downloads.id,
      optional: false,
    }),
  },
}));
