// Infrastructure settings from environment variables (spec §3).
// Everything else lives in the settings table.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** No other *arr app uses it. */
export const defaultPort = 6262;

export interface ServerConfig {
  port: number;
  /** In `CONFIG_DIR`, which is `/config` in the Docker image. */
  databasePath: string;
  /** The web build, `apps/web/dist` next to this package. */
  webDir: string;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return defaultPort;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number from 1 to 65535, got "${value}"`);
  }
  return port;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    port: parsePort(env.PORT),
    databasePath: join(resolve(env.CONFIG_DIR ?? "config"), "mangarr.db"),
    webDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  };
}
