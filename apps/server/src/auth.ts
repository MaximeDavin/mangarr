// The account and its sessions (spec §4.9, §4.10, §8).

import { createHash, randomBytes } from "node:crypto";
import { deleteCookie, setCookie } from "@orpc/server/helpers";
import { and, eq, lte, ne } from "drizzle-orm";
import type { Db } from "./db/client";
import { sessions, users } from "./db/schema";

export const sessionCookie = "mangarr_session";

const day = 24 * 60 * 60 * 1000;
export const sessionLifetimeMs = 30 * day;
/** A session used with less than this left is renewed for another `sessionLifetimeMs`. */
const renewWithinMs = 15 * day;

export interface User {
  id: number;
  username: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Argon2id at Bun's default cost (about 150 ms a hash). Tests use the cheapest settings, or the
 * auth tests spend seconds hashing. `verify` reads the cost from the hash, so it follows.
 */
const hashPassword = (password: string) =>
  Bun.password.hash(
    password,
    process.env.NODE_ENV === "test" ? { algorithm: "argon2id", memoryCost: 8, timeCost: 1 } : "argon2id",
  );

/** Also accepts a transaction, since it only needs `select`. */
export function hasUser(db: Pick<Db, "select">): boolean {
  return db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
}

/** Creates the account. Returns undefined when one already exists (v0 has a single user). */
export async function createFirstUser(db: Db, username: string, password: string): Promise<User | undefined> {
  if (hasUser(db)) return undefined;
  // Hash first: the transaction below must stay synchronous to be atomic.
  const passwordHash = await hashPassword(password);
  return db.transaction((tx) => {
    if (hasUser(tx)) return undefined;
    return tx
      .insert(users)
      .values({ username, passwordHash })
      .returning({ id: users.id, username: users.username })
      .get();
  });
}

let dummyHash: Promise<string> | undefined;

/**
 * The user, when the password is theirs. An unknown username still runs a hash check, so it takes
 * as long as a wrong password.
 */
export async function checkPassword(db: Db, username: string, password: string): Promise<User | undefined> {
  const row = db.select().from(users).where(eq(users.username, username)).get();
  if (!row) {
    dummyHash ??= hashPassword("not a real password");
    await Bun.password.verify(password, await dummyHash);
    return undefined;
  }
  return (await Bun.password.verify(password, row.passwordHash)) ? { id: row.id, username: row.username } : undefined;
}

export async function setPassword(db: Db, userId: number, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
}

/** Starts a session. Returns the token for the cookie; only its hash is stored. */
export function createSession(db: Db, userId: number, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  db.insert(sessions)
    .values({ id: hashToken(token), userId, expiresAt: new Date(now + sessionLifetimeMs) })
    .run();
  // Expired sessions are only otherwise removed when someone uses them.
  db.delete(sessions)
    .where(lte(sessions.expiresAt, new Date(now)))
    .run();
  return token;
}

/** The session's user, or undefined when the token is unknown or expired. Renews it when due. */
export function findSession(db: Db, token: string, now = Date.now()): { user: User; renewed: boolean } | undefined {
  const id = hashToken(token);
  const row = db
    .select({ expiresAt: sessions.expiresAt, userId: users.id, username: users.username })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return undefined;
  if (row.expiresAt.getTime() <= now) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return undefined;
  }
  const renewed = row.expiresAt.getTime() - now < renewWithinMs;
  if (renewed) {
    db.update(sessions)
      .set({ expiresAt: new Date(now + sessionLifetimeMs) })
      .where(eq(sessions.id, id))
      .run();
  }
  return { user: { id: row.userId, username: row.username }, renewed };
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions)
    .where(eq(sessions.id, hashToken(token)))
    .run();
}

/** Signs out every session of the user except `keepToken`'s. */
export function deleteOtherSessions(db: Db, userId: number, keepToken: string): void {
  db.delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, hashToken(keepToken))))
    .run();
}

/** For a forgotten password: the next visit shows the setup screen again. Sessions go with the user. */
export function resetAuth(db: Db): void {
  db.delete(users).run();
}

/** The parts of the API context the cookie helpers need. In-process calls have neither. */
interface CookieTarget {
  resHeaders?: Headers;
  https?: boolean;
}

const cookieOptions = ({ https = false }: CookieTarget) =>
  ({ httpOnly: true, sameSite: "strict", path: "/", secure: https }) as const;

export function setSessionCookie(context: CookieTarget, token: string): void {
  setCookie(context.resHeaders, sessionCookie, token, { ...cookieOptions(context), maxAge: sessionLifetimeMs / 1000 });
}

export function clearSessionCookie(context: CookieTarget): void {
  deleteCookie(context.resHeaders, sessionCookie, cookieOptions(context));
}

/**
 * False for a browser request sent by another site, including another app on a subdomain of the
 * same domain, which `SameSite=Strict` lets through. `Sec-Fetch-Site` is set by the browser, so a
 * reverse proxy can't change it; `Origin` against `Host` covers browsers that don't send it.
 */
export function isSameOrigin(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === headers.get("host");
  } catch {
    return false;
  }
}
