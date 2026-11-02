import { Buffer } from "buffer";

// NEAR wallet libraries expect Node's Buffer in the browser. Imported first by main.tsx.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
