// Prowlarr procedures for the Settings screen (spec §6.1, §9): the connection test and the indexer list.

import { z } from "zod";
import {
  createProwlarrClient,
  type ProwlarrCategory,
  ProwlarrError,
  prowlarrFromSettings,
} from "../integrations/prowlarr";
import { getSettings } from "../settings";
import { authed } from "./base";
import { savedSecretFor, serviceUrl } from "./settings";

const protocol = z.enum(["torrent", "usenet", "unknown"]);

const indexerOutput = z.object({
  id: z.int(),
  name: z.string(),
  enabled: z.boolean(),
  protocol,
  privacy: z.enum(["public", "semiPrivate", "private"]).optional(),
  priority: z.int().optional(),
  /** The definition's language, e.g. `en-US`. A hint for the picker only. */
  language: z.string().optional(),
  /** Parents first, each followed by its subcategories, whose names already include the parent's ("Books/Comics"). */
  categories: z.array(z.object({ id: z.int(), name: z.string() })),
});

/** Torznab categories are two levels deep; a flat list is enough for a picker. */
function flatten(categories: ProwlarrCategory[]): { id: number; name: string }[] {
  return categories.flatMap(({ id, name, subCategories }) => [{ id, name }, ...flatten(subCategories)]);
}

const tags = ["Prowlarr"];

export const prowlarrRouter = {
  test: authed
    .route({
      method: "POST",
      path: "/prowlarr/test",
      summary: "Test the Prowlarr connection",
      description:
        "Uses the given URL and API key, or the saved ones for fields left out, so the Settings form can be tested before saving. The saved key is only sent to the saved URL.",
      tags,
    })
    .input(z.object({ url: serviceUrl.optional(), apiKey: z.string().trim().optional() }))
    .output(z.object({ version: z.string() }))
    .handler(({ context, input, signal }) => {
      const saved = getSettings(context.db);
      const url = input.url ?? saved.prowlarrUrl;
      const apiKey = input.apiKey ?? savedSecretFor(url, saved.prowlarrUrl, saved.prowlarrApiKey);
      if (!url || !apiKey) throw new ProwlarrError("not_configured", "Give the Prowlarr URL and API key");
      return createProwlarrClient({ url, apiKey }).status(signal);
    }),

  indexers: authed
    .route({
      method: "GET",
      path: "/prowlarr/indexers",
      summary: "List Prowlarr's indexers",
      description: "For choosing each language's indexers and categories. Uses the saved Prowlarr settings.",
      tags,
    })
    .output(z.array(indexerOutput))
    .handler(async ({ context, signal }) => {
      const indexers = await prowlarrFromSettings(context.db).indexers(signal);
      return indexers
        .map((indexer) => ({ ...indexer, categories: flatten(indexer.categories) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }),
};
