// HTTP entry point: one fetch handler for `Bun.serve` (spec §3, §8).

import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import pkg from "../package.json" with { type: "json" };
import type { ApiContext } from "./api/base";
import { router } from "./api/router";
import type { Db } from "./db/client";
import { createMangaBakaClient, type MangaBakaClient } from "./integrations/mangabaka";
import { UpstreamError } from "./integrations/upstream";
import { ReleaseCache } from "./library/release-cache";
import { serveWeb } from "./web";

export const rpcPrefix = "/rpc";
export const restPrefix = "/api/v1";

/**
 * Logs errors that aren't deliberate API errors (those become a 500). Another service failing,
 * not answering or rate limiting is not a mangarr bug: one warning line.
 */
function logUnexpected(error: unknown) {
  if (error instanceof ORPCError && error.cause instanceof UpstreamError) {
    if (error.status >= 500 || error.status === 429) console.warn(`warning: ${error.message}`);
  } else if (!(error instanceof ORPCError) || error.status >= 500) console.error(error);
}

const schemaConverters = [new ZodToJsonSchemaConverter()];

const rpcHandler = new RPCHandler(router, {
  interceptors: [onError(logUnexpected)],
  // Lets the auth procedures set the session cookie.
  plugins: [new ResponseHeadersPlugin()],
});
const restHandler = new OpenAPIHandler(router, {
  interceptors: [onError(logUnexpected)],
  // REST path and query parameters arrive as strings; this turns "3" into 3 where the schema wants a number.
  plugins: [new SmartCoercionPlugin({ schemaConverters }), new ResponseHeadersPlugin()],
});

let openApiSpec: Promise<unknown> | undefined;

/** The OpenAPI document for /api/v1, generated once. */
export function getOpenApiSpec(): Promise<unknown> {
  openApiSpec ??= new OpenAPIGenerator({ schemaConverters })
    .generate(router, {
      info: { title: "mangarr", version: pkg.version },
      servers: [{ url: restPrefix }],
      components: {
        securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
      },
      security: [{ apiKey: [] }],
    })
    .catch((error: unknown) => {
      // Don't keep a failure: the next request tries again.
      openApiSpec = undefined;
      throw error;
    });
  return openApiSpec;
}

/**
 * Tests pass a MangaBaka client answered by recordings. Without `webDir`, only the API is served.
 */
export function createFetchHandler(
  db: Db,
  mangabaka: MangaBakaClient = createMangaBakaClient(),
  jobs: ApiContext["jobs"] = { wake() {} },
  webDir?: string,
) {
  const releases = new ReleaseCache();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;
    const https = url.protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
    const context: ApiContext = { db, headers: request.headers, https, mangabaka, releases, jobs };

    if (pathname === `${restPrefix}/openapi.json` && request.method === "GET") {
      // Public: it describes the API but holds no data.
      return Response.json(await getOpenApiSpec());
    }

    const handled = pathname.startsWith(`${rpcPrefix}/`)
      ? await rpcHandler.handle(request, { prefix: rpcPrefix, context })
      : pathname.startsWith(`${restPrefix}/`)
        ? await restHandler.handle(request, { prefix: restPrefix, context })
        : { matched: false as const };
    if (handled.matched) return handled.response;

    const isApi = pathname.startsWith(`${rpcPrefix}/`) || pathname.startsWith(`${restPrefix}/`);
    if (!isApi && (request.method === "GET" || request.method === "HEAD")) {
      const page = webDir === undefined ? undefined : await serveWeb(webDir, pathname);
      if (page) return page;
    }
    return new Response("Not found", { status: 404 });
  };
}
