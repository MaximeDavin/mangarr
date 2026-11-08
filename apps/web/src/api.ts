// The typed oRPC client and its TanStack Query helpers (spec §8). Types come straight from the
// server's router, so there is no codegen. The browser sends the session cookie on its own.

import type { Router } from "@mangarr/server/router";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

const link = new RPCLink({ url: `${window.location.origin}/rpc` });

export const client: RouterClient<Router> = createORPCClient(link);

/** `orpc.series.list.queryOptions({ input })`, `orpc.series.create.mutationOptions()`, … */
export const orpc = createTanstackQueryUtils(client);

/** Who is signed in. Kept until sign-in, sign-out or a 401 changes it. */
export const authStatusQuery = orpc.auth.status.queryOptions({ staleTime: Infinity });

/** Only paths on this site, so `?redirect=` can't send you elsewhere after signing in. */
export function safeRedirect(path: string | undefined): string {
  return path?.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : "/";
}

declare module "@tanstack/react-query" {
  interface Register {
    /** `signIn: true` on the login mutation, whose 401 means a wrong password, not a lost session. */
    mutationMeta: { signIn?: boolean };
  }
}

/**
 * The session expired or was signed out elsewhere: start again from the login page. A full
 * reload, so nothing from the old session stays in memory.
 */
function onUnauthorized(error: Error) {
  if (!(error instanceof ORPCError) || error.code !== "UNAUTHORIZED") return;
  const { pathname, search } = window.location;
  window.location.assign(`/login?${new URLSearchParams({ redirect: pathname + search })}`);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onUnauthorized }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (!mutation.meta?.signIn) onUnauthorized(error);
    },
  }),
  defaultOptions: {
    queries: {
      // mangarr is a LAN app with one user: data changes because you changed it, or because
      // a download moved on, which the screens that care poll for.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
      // A query with nothing to show throws to the route's error screen (router.tsx), so pages
      // don't each handle errors. A failed refetch keeps the data already on screen.
      throwOnError: (_error, query) => query.state.data === undefined,
    },
  },
});
