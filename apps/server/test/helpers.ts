// Helpers shared by the test files.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient, ORPCError, type RouterClient } from "@orpc/server";
import { type Router, router } from "../src/api/router";
import type { Db } from "../src/db/client";
import type { MangaBakaClient } from "../src/integrations/mangabaka";
import { ReleaseCache } from "../src/library/release-cache";
import { replayedMangaBaka } from "./mangabaka-replay";

/** An in-process API client. MangaBaka is answered by the recordings unless another client is given. */
export function apiClient(
  db: Db,
  {
    apiKey,
    mangabaka,
    releases,
    jobs,
  }: { apiKey?: string; mangabaka?: MangaBakaClient; releases?: ReleaseCache; jobs?: { wake(): void } } = {},
) {
  const headers = new Headers(apiKey ? { "x-api-key": apiKey } : {});
  return createRouterClient(router, {
    context: {
      db,
      headers,
      mangabaka: mangabaka ?? replayedMangaBaka().mangabaka,
      releases: releases ?? new ReleaseCache(),
      jobs: jobs ?? { wake() {} },
    },
  });
}

/**
 * Real HTTP requests to a fetch handler (`createFetchHandler`), always with `headers` unless a
 * call overrides them. `rest` paths include `/api/v1`.
 */
export function overHttp(handle: (request: Request) => Promise<Response>, headers: Record<string, string>) {
  const rest = (path: string, init: RequestInit = {}) =>
    handle(
      new Request(`http://mangarr${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...headers, ...init.headers },
      }),
    );
  const rpc: RouterClient<Router> = createORPCClient(
    new RPCLink({ url: "http://mangarr/rpc", headers, fetch: (request) => handle(request) }),
  );
  return { rest, rpc };
}

/** The error `call` fails with. Fails the test when it succeeds or throws something else. */
export async function rejection<E extends Error = ORPCError<string, unknown>>(
  call: Promise<unknown>,
  type: abstract new (...args: never[]) => E = ORPCError as never,
): Promise<E> {
  try {
    await call;
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/** The oRPC error code `call` fails with. */
export const errorCode = async (call: Promise<unknown>) => (await rejection(call)).code;
