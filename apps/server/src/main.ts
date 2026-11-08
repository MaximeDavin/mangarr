import { loadConfig } from "./config";
import { openDatabase } from "./db/client";
import { createFetchHandler } from "./http";
import { createPoller } from "./jobs/poller";
import { scanAllSeries } from "./library/scan";
import { ensureApiKey } from "./settings";

const config = loadConfig();
const db = openDatabase(config.databasePath);
ensureApiKey(db);

const poller = createPoller(db);
const server = Bun.serve({ port: config.port, fetch: createFetchHandler(db, undefined, poller, config.webDir) });

console.log(`mangarr: database ready at ${config.databasePath}`);
console.log(`mangarr: listening on ${server.url}`);

// Spec §7.5: every series is scanned once at startup, in the background, so the API is up meanwhile.
// The poller starts after it, so imports see what is already on disk.
void scanAllSeries(db).finally(() => poller.start());
