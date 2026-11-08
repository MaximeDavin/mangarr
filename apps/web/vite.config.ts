import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// The server's version is mangarr's version: it ships this UI.
import serverPkg from "../server/package.json" with { type: "json" };

/** The mangarr server in development (`bun run --filter @mangarr/server dev`). */
const server = `http://localhost:${process.env.PORT ?? 6262}`;

export default defineConfig({
  plugins: [react()],
  define: {
    __MANGARR_VERSION__: JSON.stringify(serverPkg.version),
  },
  // One bundle is fine for a LAN app; most of it is Mantine.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    port: 5173,
    // The API lives on the mangarr server. The SPA calls it on its own origin, so the session
    // cookie is set for localhost:5173 and sent back without any CORS setup.
    proxy: {
      "/rpc": server,
      "/api": server,
    },
  },
});
