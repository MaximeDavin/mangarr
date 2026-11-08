// The oRPC building blocks every procedure starts from (spec §8).

import { timingSafeEqual } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import { getCookie } from "@orpc/server/helpers";
import { findSession, isSameOrigin, sessionCookie, setSessionCookie, type User } from "../auth";
import type { Db } from "../db/client";
import type { MangaBakaClient } from "../integrations/mangabaka";
import { UpstreamError, type UpstreamErrorKind } from "../integrations/upstream";
import type { ReleaseCache } from "../library/release-cache";
import { getSetting } from "../settings";

/** What the HTTP layer passes to every call. */
export interface ApiContext {
  db: Db;
  /** The request headers, read by the auth checks. */
  headers: Headers;
  /** Response headers, for the session cookie. Set by oRPC's ResponseHeadersPlugin; absent in-process. */
  resHeaders?: Headers;
  /** The request came over HTTPS (directly or through a proxy), so cookies get `Secure`. Absent in-process. */
  https?: boolean;
  mangabaka: MangaBakaClient;
  /** The latest search results, for Grab. One per server. */
  releases: ReleaseCache;
  /** The job loop, so a procedure can make it run now. */
  jobs: { wake(): void };
}

export const base = os.$context<ApiContext>();

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A signed-in browser: the user, and the token from their cookie. */
export interface Session {
  user: User;
  token: string;
}

/** The cookie's session, renewing the cookie when due. Undefined without a valid one. */
function currentSession(context: ApiContext): Session | undefined {
  const token = getCookie(context.headers, sessionCookie);
  const found = token ? findSession(context.db, token) : undefined;
  if (!token || !found) return undefined;
  if (found.renewed) setSessionCookie(context, token);
  return { user: found.user, token };
}

/**
 * Where every procedure starts (spec §8). A request without the API key is refused when another
 * site sent it, before the session is even looked up. `context.session` is set for a signed-in
 * browser; an API-key request ignores cookies, since the key isn't anyone's.
 */
export const publicProcedure = base.use(({ context, next }) => {
  const apiKey = context.headers.get("x-api-key");
  if (!apiKey && !isSameOrigin(context.headers)) {
    throw new ORPCError("FORBIDDEN", { message: "Refused a request sent by another site" });
  }
  return next({ context: { session: apiKey ? undefined : currentSession(context) } });
});

/** Needs a session cookie or the mangarr API key in `X-Api-Key`. */
const requireAuth = os.$context<ApiContext & { session: Session | undefined }>().middleware(({ context, next }) => {
  const given = context.headers.get("x-api-key");
  if (given) {
    const expected = getSetting(context.db, "apiKey");
    if (!expected || !sameKey(given, expected)) {
      throw new ORPCError("UNAUTHORIZED", { message: "Invalid X-Api-Key header" });
    }
  } else if (!context.session) {
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in, or send the API key in the X-Api-Key header" });
  }
  return next();
});

/** Codes used when another service fails. */
const upstreamCodes: Record<UpstreamErrorKind, string> = {
  not_configured: "PRECONDITION_FAILED",
  not_found: "NOT_FOUND",
  rate_limited: "TOO_MANY_REQUESTS",
  // A 502, not a 401: the UI must not read it as mangarr's own key being wrong.
  unauthorized: "BAD_GATEWAY",
  unreachable: "BAD_GATEWAY",
  http: "BAD_GATEWAY",
  invalid_response: "BAD_GATEWAY",
  timeout: "GATEWAY_TIMEOUT",
};

/**
 * Turns an UpstreamError into an API error with the same message, and `data.kind` (plus
 * `retryAfterSeconds` when known) for the UI. The UpstreamError stays as the `cause`.
 */
export const mapUpstreamErrors = base.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    const data: { kind: UpstreamErrorKind; retryAfterSeconds?: number } = { kind: error.kind };
    if (error.retryAfterSeconds !== undefined) data.retryAfterSeconds = error.retryAfterSeconds;
    throw new ORPCError(upstreamCodes[error.kind], { message: error.message, data, cause: error });
  }
});

export const authed = publicProcedure.use(requireAuth).use(mapUpstreamErrors);
