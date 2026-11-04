import { Buffer } from "buffer";

// NEAR wallet libraries expect Node's Buffer in the browser. Imported first by main.tsx.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
// Unbundled dev mode also leaves `process.env` reads in the Meteor wallet SDK.
(globalThis as { process?: { env: Record<string, string> } }).process ??= { env: {} };
