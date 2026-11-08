// Sign-in over real HTTP requests (spec §8): setup, login, the session cookie, cross-site
// refusals, logout and password changes.

import { describe, expect, it } from "bun:test";
import { createSession, findSession, resetAuth, sessionLifetimeMs } from "../src/auth";
import { openDatabase } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import { createFetchHandler } from "../src/http";
import { ensureApiKey } from "../src/settings";
import { overHttp } from "./helpers";

const account = { username: "max", password: "correct horse" };

/** What a browser on mangarr's own page sends. */
const sameOrigin = { "sec-fetch-site": "same-origin" };

function setup() {
  const db = openDatabase(":memory:");
  const apiKey = ensureApiKey(db);
  const handle = createFetchHandler(db);

  const http = overHttp(handle, sameOrigin);
  const rest = (path: string, init?: RequestInit) => http.rest(`/api/v1${path}`, init);
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    rest(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers });

  /** Creates the account and returns the session cookie it set. */
  const signUp = async () => sessionCookie(await post("/auth/setup", account));

  return { db, apiKey, handle, rest, post, signUp };
}

/** The `mangarr_session` Set-Cookie line. */
function setCookieLine(response: Response): string {
  const line = response.headers.getSetCookie().find((cookie) => cookie.startsWith("mangarr_session="));
  if (!line) throw new Error(`no session cookie (HTTP ${response.status})`);
  return line;
}

/** The Cookie header a browser would send back. */
const sessionCookie = (response: Response) => setCookieLine(response).split(";")[0]!;

describe("first start", () => {
  it("asks for setup until the account exists", async () => {
    const { rest, post } = setup();
    expect(await (await rest("/auth/status")).json()).toEqual({ setupRequired: true, username: null });

    const created = await post("/auth/setup", account);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ username: "max" });
    const cookie = sessionCookie(created);

    expect(await (await rest("/auth/status")).json()).toEqual({ setupRequired: false, username: null });
    expect(await (await rest("/auth/status", { headers: { cookie } })).json()).toEqual({
      setupRequired: false,
      username: "max",
    });
  });

  it("refuses a second account and short passwords", async () => {
    const { post, signUp } = setup();
    expect((await post("/auth/setup", { username: "max", password: "short" })).status).toBe(400);
    await signUp();
    const again = await post("/auth/setup", { username: "eve", password: "another password" });
    expect(again.status).toBe(409);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it("stores neither the password nor the token", async () => {
    const { db, signUp } = setup();
    const cookie = await signUp();
    const token = cookie.split("=")[1]!;
    expect(db.select().from(users).get()!.passwordHash).toStartWith("$argon2id$");
    expect(db.select().from(sessions).get()!.id).not.toBe(token);
    expect(db.select().from(sessions).get()!.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the session cookie", () => {
  it("is HttpOnly, SameSite=Strict and lasts 30 days", async () => {
    const { post } = setup();
    const line = setCookieLine(await post("/auth/setup", account));
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Strict");
    expect(line).toContain("Path=/");
    expect(line).toContain("Max-Age=2592000");
    expect(line).not.toContain("Secure");
  });

  it("is Secure over HTTPS, directly or through a proxy", async () => {
    const direct = setup();
    const overHttps = new Request("https://mangarr/api/v1/auth/setup", {
      method: "POST",
      body: JSON.stringify(account),
      headers: { "content-type": "application/json", ...sameOrigin },
    });
    expect(setCookieLine(await direct.handle(overHttps))).toContain("Secure");
    const proxied = setup();
    expect(setCookieLine(await proxied.post("/auth/setup", account, { "x-forwarded-proto": "https" }))).toContain(
      "Secure",
    );
  });

  it("opens the API on /api/v1 and /rpc", async () => {
    const { handle, rest, signUp } = setup();
    const cookie = await signUp();
    expect((await rest("/settings", { headers: { cookie } })).status).toBe(200);

    expect(await overHttp(handle, { ...sameOrigin, cookie }).rpc.languages.list()).toEqual([]);
  });

  it("is refused when unknown", async () => {
    const { rest, signUp } = setup();
    await signUp();
    expect((await rest("/settings")).status).toBe(401);
    expect((await rest("/settings", { headers: { cookie: "mangarr_session=forged" } })).status).toBe(401);
  });
});

describe("cross-site requests", () => {
  it("are refused with a cookie, even from a sibling subdomain", async () => {
    const { rest, signUp } = setup();
    const cookie = await signUp();
    for (const site of ["cross-site", "same-site"]) {
      expect((await rest("/settings", { headers: { cookie, "sec-fetch-site": site } })).status).toBe(403);
    }
    expect((await rest("/settings", { headers: { cookie, "sec-fetch-site": "none" } })).status).toBe(200);
  });

  it("fall back to Origin against Host when the browser sends no Sec-Fetch-Site", async () => {
    const { handle, signUp } = setup();
    const cookie = await signUp();
    const get = (origin: string) =>
      handle(new Request("http://mangarr:6262/api/v1/settings", { headers: { cookie, origin, host: "mangarr:6262" } }));
    expect((await get("http://evil.example")).status).toBe(403);
    expect((await get("http://mangarr:6262")).status).toBe(200);
  });

  it("are refused without a cookie too, public procedures included", async () => {
    const { rest, post } = setup();
    const crossSite = { "sec-fetch-site": "cross-site" };
    expect((await post("/auth/setup", account, crossSite)).status).toBe(403);
    expect((await post("/auth/login", account, crossSite)).status).toBe(403);
    expect((await rest("/auth/status", { headers: crossSite })).status).toBe(403);
    expect((await rest("/settings", { headers: crossSite })).status).toBe(403);
  });

  it("don't matter with the API key, which browsers never attach on their own", async () => {
    const { apiKey, rest } = setup();
    const headers = { "x-api-key": apiKey, "sec-fetch-site": "cross-site" };
    expect((await rest("/settings", { headers })).status).toBe(200);
  });
});

describe("login", () => {
  it("gives the same answer for a wrong password and an unknown user", async () => {
    const { post, signUp } = setup();
    await signUp();
    const wrongPassword = await post("/auth/login", { username: "max", password: "wrong password" });
    const unknownUser = await post("/auth/login", { username: "eve", password: "correct horse" });
    for (const response of [wrongPassword, unknownUser]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ message: "Wrong username or password" });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("starts a new session", async () => {
    const { rest, post, signUp } = setup();
    const first = await signUp();
    const second = sessionCookie(await post("/auth/login", account));
    expect(second).not.toBe(first);
    expect((await rest("/settings", { headers: { cookie: second } })).status).toBe(200);
    expect((await rest("/settings", { headers: { cookie: first } })).status).toBe(200);
  });
});

describe("logout", () => {
  it("ends the session and clears the cookie", async () => {
    const { rest, post, signUp } = setup();
    const cookie = await signUp();
    const response = await post("/auth/logout", undefined, { cookie });
    expect(response.status).toBe(204);
    expect(setCookieLine(response)).toContain("Max-Age=0");
    expect((await rest("/settings", { headers: { cookie } })).status).toBe(401);
  });
});

describe("changing the password", () => {
  const change = { currentPassword: account.password, newPassword: "battery staple" };

  it("checks the current one and signs out the other sessions", async () => {
    const { rest, post, signUp } = setup();
    const cookie = await signUp();
    const other = sessionCookie(await post("/auth/login", account));

    expect((await post("/auth/password", { ...change, currentPassword: "wrong password" }, { cookie })).status).toBe(
      400,
    );
    expect((await post("/auth/password", { ...change, newPassword: "short" }, { cookie })).status).toBe(400);
    expect((await post("/auth/password", change, { cookie })).status).toBe(204);

    expect((await rest("/settings", { headers: { cookie } })).status).toBe(200);
    expect((await rest("/settings", { headers: { cookie: other } })).status).toBe(401);
    expect((await post("/auth/login", account)).status).toBe(401);
    expect((await post("/auth/login", { username: "max", password: "battery staple" })).status).toBe(200);
  });

  it("needs a session, not the API key", async () => {
    const { apiKey, post, signUp } = setup();
    await signUp();
    expect((await post("/auth/password", change, { "x-api-key": apiKey })).status).toBe(403);
  });
});

describe("sessions", () => {
  it("expire after 30 days, and are renewed when used in their second half", async () => {
    const { db, signUp } = setup();
    await signUp();
    const userId = db.select().from(users).get()!.id;
    const start = Date.now();
    const token = createSession(db, userId, start);

    expect(findSession(db, token, start + 1000)?.renewed).toBe(false);
    const late = start + sessionLifetimeMs - 1000;
    expect(findSession(db, token, late)?.renewed).toBe(true);
    // Renewed from `late`, so still valid past the first 30 days.
    expect(findSession(db, token, start + sessionLifetimeMs + 1000)?.user.username).toBe("max");
    expect(findSession(db, token, late + sessionLifetimeMs + 1)).toBeUndefined();
    expect(findSession(db, token, start)).toBeUndefined();
  });

  it("all go when the account is reset, and setup is asked again", async () => {
    const { db, rest, signUp } = setup();
    const cookie = await signUp();
    resetAuth(db);
    expect(db.select().from(sessions).all()).toEqual([]);
    expect(await (await rest("/auth/status", { headers: { cookie } })).json()).toEqual({
      setupRequired: true,
      username: null,
    });
  });
});
