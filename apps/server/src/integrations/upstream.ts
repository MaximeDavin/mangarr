// What every client of another service (Prowlarr, MangaBaka, later qBittorrent and Komga) shares.

/** The part of `fetch` the clients use, so tests can pass a fake. */
export type Fetch = (request: Request) => Promise<Response>;

export type UpstreamErrorKind =
  | "not_configured"
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  /** Any other error status. */
  | "http"
  /** Not JSON, not the expected shape, or not the expected service at all. */
  | "invalid_response";

/** Another service failed or refused. The API turns it into one error response (see `api/base.ts`). */
export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status: number | undefined;
  /** For `rate_limited`, when the service said how long to wait. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: UpstreamErrorKind,
    message: string,
    options: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "UpstreamError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
