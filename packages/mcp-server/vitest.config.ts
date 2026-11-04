import { defineConfig } from "vitest/config";

// Several tests start an in-process PGlite database, which takes a few seconds on slower machines.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
