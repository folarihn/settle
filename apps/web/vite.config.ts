import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (default :8080); in production it serves this build.
export default defineConfig({
  plugins: [react()],
  // The Meteor wallet SDK references Node's `global`; browsers only have `globalThis`.
  define: { global: "globalThis" },
  server: {
    proxy: {
      "/v1": process.env.SETTLE_API_ORIGIN ?? "http://localhost:8080",
      "/fixture": process.env.SETTLE_API_ORIGIN ?? "http://localhost:8080",
    },
  },
});
