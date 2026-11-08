// Komga procedures for the Settings screen (spec §6.3, §9): the connection test and the library list.

import { z } from "zod";
import { createKomgaClient, KomgaError, komgaFromSettings } from "../integrations/komga";
import { getSettings } from "../settings";
import { authed } from "./base";
import { savedSecretFor, serviceUrl } from "./settings";

const libraryOutput = z.object({ id: z.string(), name: z.string(), root: z.string() });

const tags = ["Komga"];

export const komgaRouter = {
  test: authed
    .route({
      method: "POST",
      path: "/komga/test",
      summary: "Test the Komga connection",
      description:
        "Lists the libraries, and says whether the key may start scans (only admins can). Uses the given URL and API key, or the saved ones for fields left out, so the Settings form can be tested before saving. The saved key is only sent to the saved URL.",
      tags,
    })
    .input(z.object({ url: serviceUrl.optional(), apiKey: z.string().trim().optional() }))
    .output(
      z.object({
        libraries: z.array(libraryOutput),
        /** False when the key's user isn't an admin: every scan after an import would be refused. */
        canScan: z.boolean(),
      }),
    )
    .handler(async ({ context, input, signal }) => {
      const saved = getSettings(context.db);
      const url = input.url ?? saved.komgaUrl;
      const apiKey = input.apiKey ?? savedSecretFor(url, saved.komgaUrl, saved.komgaApiKey);
      if (!url || !apiKey) throw new KomgaError("not_configured", "Give the Komga URL and API key");
      const client = createKomgaClient({ url, apiKey });
      const libraries = await client.libraries(signal);
      const { isAdmin } = await client.me(signal);
      return { libraries, canScan: isAdmin };
    }),

  libraries: authed
    .route({
      method: "GET",
      path: "/komga/libraries",
      summary: "List Komga's libraries",
      description: "For choosing each language's library. Uses the saved Komga settings.",
      tags,
    })
    .output(z.array(libraryOutput))
    .handler(async ({ context, signal }) => {
      const libraries = await komgaFromSettings(context.db).libraries(signal);
      return libraries.sort((a, b) => a.name.localeCompare(b.name));
    }),
};
