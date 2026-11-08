// For a forgotten password (spec §8): deletes the account and every session, so the next visit
// shows the setup screen. Run with `bun run auth:reset`, or `docker exec -w /app/mangarr mangarr bun run auth:reset`.

import { resetAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { openDatabase } from "../src/db/client";

const config = loadConfig();
resetAuth(openDatabase(config.databasePath));
console.log(`mangarr: account deleted in ${config.databasePath}. Open mangarr to create a new one.`);
