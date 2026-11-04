import { existsSync, readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const api = process.env.SETTLE_API_ORIGIN ?? "http://localhost:8080";

/**
 * Development only (`vite` serve, never `vite build`): if `.preview-session.json` exists next to
 * this file ({accountId, token} for a test account, git-ignored), the app opens signed in with
 * that real API session and a wallet stub that refuses to sign. Used to review the UI against
 * real data without a browser wallet.
 */
function previewSession(): Plugin {
  const file = new URL("./.preview-session.json", import.meta.url);
  return {
    name: "settle-preview-session",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__preview-session", (_req, res) => {
        if (!existsSync(file)) {
          res.statusCode = 404;
          return res.end("{}");
        }
        res.setHeader("content-type", "application/json");
        res.end(readFileSync(file));
      });
    },
  };
}

// In development the API runs separately (default :8080); in production it serves this build.
export default defineConfig({
  plugins: [react(), previewSession()],
  // The Meteor wallet SDK references Node's `global`; browsers only have `globalThis`.
  define: { global: "globalThis" },
  server: {
    proxy: {
      "/v1": { target: api, changeOrigin: true },
      "/fixture": { target: api, changeOrigin: true },
    },
  },
});
