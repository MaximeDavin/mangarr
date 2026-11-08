// The web build, served next to the API.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/client";
import { createFetchHandler } from "../src/http";

const webDir = mkdtempSync(join(tmpdir(), "mangarr-web-"));
mkdirSync(join(webDir, "assets"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>mangarr</title>");
writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log('hi')");
writeFileSync(join(webDir, "favicon.svg"), "<svg/>");
afterAll(() => rmSync(webDir, { recursive: true, force: true }));

function setup(dir: string | undefined = webDir) {
  const db = openDatabase(":memory:");
  const handle = createFetchHandler(db, undefined, undefined, dir);
  const get = (path: string, method = "GET") => handle(new Request(`http://mangarr${path}`, { method }));
  return { get };
}

describe("web build", () => {
  it("serves index.html at the root and for client-side routes", async () => {
    const { get } = setup();
    for (const path of ["/", "/series/12", "/settings"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toContain("<title>mangarr</title>");
    }
  });

  it("serves hashed assets as immutable, other files as no-cache", async () => {
    const { get } = setup();
    const asset = await get("/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("console.log('hi')");
    expect((await get("/favicon.svg")).headers.get("cache-control")).toBe("no-cache");
  });

  it("answers missing files with 404, not the app", async () => {
    const { get } = setup();
    expect((await get("/favicon.ico")).status).toBe(404);
    expect((await get("/assets/gone-123.js")).status).toBe(404);
  });

  it("never serves files outside the build", async () => {
    const { get } = setup();
    for (const path of ["/..%2F..%2Fetc%2Fpasswd", "/%2e%2e/%2e%2e/secret.txt", "/assets/..%5C..%5Csecret.txt"]) {
      const response = await get(path);
      if (response.status === 200) expect(await response.text()).toContain("<title>mangarr</title>");
      else expect(response.status).toBe(404);
    }
  });

  it("leaves API paths and other methods to the API", async () => {
    const { get } = setup();
    expect((await get("/api/v1/nope")).status).toBe(404);
    expect((await get("/rpc/nope")).status).toBe(404);
    expect((await get("/", "POST")).status).toBe(404);
  });

  it("says how to build the UI when there is no build", async () => {
    const { get } = setup(join(webDir, "missing"));
    const response = await get("/");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("isn't built");
  });
});
