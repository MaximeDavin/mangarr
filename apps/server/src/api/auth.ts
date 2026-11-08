// Sign-in procedures (spec §8). All but `changePassword` are public: they are how you get a session.

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  checkPassword,
  clearSessionCookie,
  createFirstUser,
  createSession,
  deleteOtherSessions,
  deleteSession,
  hasUser,
  setPassword,
  setSessionCookie,
} from "../auth";
import { minPasswordLength } from "../password-rules";
import { authed, publicProcedure } from "./base";

const tags = ["Auth"];

const username = z.string().trim().min(1).max(64);
/** The upper bound only keeps hashing cheap. */
const newPassword = z.string().min(minPasswordLength, `Use at least ${minPasswordLength} characters`).max(1024);
const credentials = z.object({ username, password: z.string().max(1024) });
const signedIn = z.object({ username: z.string() });

export const authRouter = {
  status: publicProcedure
    .route({
      method: "GET",
      path: "/auth/status",
      summary: "Who is signed in",
      description: "`setupRequired` is true until the account is created. `username` is null when not signed in.",
      tags,
    })
    .output(z.object({ setupRequired: z.boolean(), username: z.string().nullable() }))
    .handler(({ context }) => ({
      setupRequired: !hasUser(context.db),
      username: context.session?.user.username ?? null,
    })),

  setup: publicProcedure
    .route({
      method: "POST",
      path: "/auth/setup",
      summary: "Create the account",
      description: "Only works on first start, while no account exists. Signs in.",
      tags,
    })
    .input(z.object({ username, password: newPassword }))
    .output(signedIn)
    .handler(async ({ context, input }) => {
      const user = await createFirstUser(context.db, input.username, input.password);
      if (!user) throw new ORPCError("CONFLICT", { message: "The account already exists. Sign in instead." });
      setSessionCookie(context, createSession(context.db, user.id));
      return { username: user.username };
    }),

  login: publicProcedure
    .route({ method: "POST", path: "/auth/login", summary: "Sign in", description: "Sets the session cookie.", tags })
    .input(credentials)
    .output(signedIn)
    .handler(async ({ context, input }) => {
      const user = await checkPassword(context.db, input.username, input.password);
      if (!user) throw new ORPCError("UNAUTHORIZED", { message: "Wrong username or password" });
      setSessionCookie(context, createSession(context.db, user.id));
      return { username: user.username };
    }),

  logout: publicProcedure
    .route({ method: "POST", path: "/auth/logout", summary: "Sign out", tags, successStatus: 204 })
    .handler(({ context }) => {
      if (context.session) deleteSession(context.db, context.session.token);
      clearSessionCookie(context);
    }),

  changePassword: authed
    .route({
      method: "POST",
      path: "/auth/password",
      summary: "Change the password",
      description: "Needs a session, not the API key. Signs out every other session.",
      tags,
      successStatus: 204,
    })
    .input(z.object({ currentPassword: z.string().max(1024), newPassword }))
    .handler(async ({ context, input }) => {
      const { session } = context;
      if (!session) throw new ORPCError("FORBIDDEN", { message: "Sign in to change the password" });
      if (!(await checkPassword(context.db, session.user.username, input.currentPassword))) {
        throw new ORPCError("BAD_REQUEST", { message: "The current password is wrong" });
      }
      await setPassword(context.db, session.user.id, input.newPassword);
      deleteOtherSessions(context.db, session.user.id, session.token);
    }),
};
