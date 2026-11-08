// MangaBaka search for the add-series flow (spec §6.4, §7.1).

import { z } from "zod";
import { authed } from "./base";

const searchResult = z.object({
  mangabakaId: z.int(),
  title: z.string(),
  nativeTitle: z.string().optional(),
  romanizedTitle: z.string().optional(),
  /** e.g. `manga`, `manhwa`. */
  type: z.string(),
  /** e.g. `releasing`, `completed`. */
  status: z.string(),
  year: z.int().optional(),
  thumbnailUrl: z.string().optional(),
  authors: z.array(z.string()),
  /** Volumes in the original language. */
  finalVolume: z.number().optional(),
});

export const mangabakaRouter = {
  search: authed
    .route({
      method: "GET",
      path: "/mangabaka/search",
      summary: "Search MangaBaka",
      description:
        "Series search for the add-series flow. Novels are left out. MangaBaka allows 30 searches a minute, so debounce typing.",
      tags: ["MangaBaka"],
    })
    .input(z.object({ query: z.string().trim().min(1), limit: z.int().min(1).max(50).default(20) }))
    .output(z.array(searchResult))
    .handler(async ({ context, input, signal }) => {
      const results = await context.mangabaka.search(input.query, { limit: input.limit, signal });
      // The output schema drops the fields the picker doesn't need.
      return results.map(({ id, ...rest }) => ({ mangabakaId: id, ...rest }));
    }),
};
