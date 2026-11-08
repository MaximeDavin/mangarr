// Komga client (spec §6.3): list the libraries (for the connection test and the Language picker),
// check the key's user may scan, and ask for a library scan after an import.
//
// Authentication uses a Komga API key (Komga ≥ 1.20) in the `X-API-Key` header. Scanning needs
// the key's user to be an admin.

import { z } from "zod";
import type { Db } from "../db/client";
import { errorMessage } from "../errors";
import { getSettings } from "../settings";
import { type Fetch, UpstreamError } from "./upstream";

export interface KomgaOptions {
  /** e.g. `http://komga:25600`, or with a base path such as `http://host/komga`. */
  url: string;
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export type KomgaErrorKind =
  | "not_configured"
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "not_found"
  | "http"
  | "invalid_response";

export class KomgaError extends UpstreamError {
  declare readonly kind: KomgaErrorKind;

  constructor(kind: KomgaErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(kind, message, options);
    this.name = "KomgaError";
  }
}

export interface KomgaLibrary {
  id: string;
  name: string;
  /** The library folder, as Komga sees it. */
  root: string;
}

const librarySchema = z.object({ id: z.string().min(1), name: z.string(), root: z.string() });
const userSchema = z.object({ roles: z.array(z.string()) });

export interface KomgaUser {
  roles: string[];
  /** Only admins may start a library scan. */
  isAdmin: boolean;
}

/** Komga (Spring) answers errors with `{ message }`, sometimes empty. */
function errorDetail(body: string): string | undefined {
  try {
    const message = (JSON.parse(body) as { message?: unknown })?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Not JSON: fall back to the text.
  }
  const text = body.trim().slice(0, 200);
  return text && !text.startsWith("<") ? text : undefined;
}

const isTimeout = (error: unknown) => (error as { name?: unknown })?.name === "TimeoutError";

export function createKomgaClient(options: KomgaOptions) {
  const baseUrl = options.url.trim().replace(/\/+$/, "");
  const fetchImpl: Fetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 15_000;

  /** Calls `/api/<path>` and returns the body text. Errors name the base URL only. */
  async function call(method: "GET" | "POST", path: string, signal?: AbortSignal): Promise<string> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const failed = (error: unknown): never => {
      if (signal?.aborted) throw error;
      if (isTimeout(error)) {
        throw new KomgaError("timeout", `Komga at ${baseUrl} did not answer within ${timeoutMs / 1000} s`, {
          cause: error,
        });
      }
      throw new KomgaError("unreachable", `Could not reach Komga at ${baseUrl}: ${errorMessage(error)}`, {
        cause: error,
      });
    };

    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(
        new Request(`${baseUrl}/api/${path}`, {
          method,
          headers: { "X-API-Key": options.apiKey, Accept: "application/json" },
          signal: AbortSignal.any(signals),
        }),
      );
      body = await response.text();
    } catch (error) {
      return failed(error);
    }

    if (response.status === 401) throw new KomgaError("unauthorized", "Komga rejected the API key", { status: 401 });
    if (response.status === 403) {
      throw new KomgaError("unauthorized", "Komga refused: the API key's user must be an admin to scan libraries", {
        status: 403,
      });
    }
    if (!response.ok) {
      const detail = errorDetail(body);
      const kind = response.status === 404 ? "not_found" : "http";
      throw new KomgaError(kind, `Komga answered ${response.status}${detail ? `: ${detail}` : ""}`, {
        status: response.status,
      });
    }
    return body;
  }

  /** The JSON body of a GET, in the shape of `schema` (extra fields dropped). */
  async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const body = await call("GET", path, signal);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      throw new KomgaError("invalid_response", `${baseUrl} did not answer like Komga (not JSON). Check the URL.`, {
        cause: error,
      });
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new KomgaError(
        "invalid_response",
        `${baseUrl} did not answer like Komga: ${z.prettifyError(result.error)}`,
        {
          cause: result.error,
        },
      );
    }
    return result.data;
  }

  /** Runs `request` for one library, naming the library when Komga doesn't have it. */
  async function forLibrary<T>(libraryId: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof KomgaError && error.kind === "not_found") {
        throw new KomgaError("not_found", `Komga has no library ${libraryId}`, { status: 404, cause: error });
      }
      throw error;
    }
  }

  const libraryPath = (libraryId: string) => `v1/libraries/${encodeURIComponent(libraryId)}`;

  return {
    /** Every library. Also the connection test: fails on a wrong URL or key. */
    libraries: (signal?: AbortSignal): Promise<KomgaLibrary[]> =>
      getJson("v1/libraries", z.array(librarySchema), signal),

    /** One library, to check a Language's library id and folder. */
    library: (libraryId: string, signal?: AbortSignal): Promise<KomgaLibrary> =>
      forLibrary(libraryId, () => getJson(libraryPath(libraryId), librarySchema, signal)),

    /** The key's user, to tell whether it may scan. */
    async me(signal?: AbortSignal): Promise<KomgaUser> {
      const { roles } = await getJson("v2/users/me", userSchema, signal);
      return { roles, isAdmin: roles.includes("ADMIN") };
    },

    /** Asks Komga to scan a library for new files (not a deep scan). Komga answers at once and scans in the background. */
    async scanLibrary(libraryId: string, signal?: AbortSignal): Promise<void> {
      await forLibrary(libraryId, () => call("POST", `${libraryPath(libraryId)}/scan`, signal));
    },
  };
}

export type KomgaClient = ReturnType<typeof createKomgaClient>;

/** A client using the saved Komga URL and API key. */
export function komgaFromSettings(db: Db, fetch?: Fetch): KomgaClient {
  const { komgaUrl, komgaApiKey } = getSettings(db);
  if (!komgaUrl || !komgaApiKey)
    throw new KomgaError("not_configured", "Set the Komga URL and API key in Settings first");
  return createKomgaClient({ url: komgaUrl, apiKey: komgaApiKey, fetch });
}
