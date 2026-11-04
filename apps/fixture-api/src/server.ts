import { createServer } from "node:http";
import { fixtureResponse } from "./index.js";

const port = Number(process.env.PORT ?? 8090);
createServer((req, res) => {
  const r = fixtureResponse(req.method ?? "GET", req.url ?? "/");
  res.writeHead(r?.status ?? 404, { "content-type": "application/json" }).end(r?.body ?? '{"error":"not found"}');
}).listen(port, () => console.log(`fixture API listening on :${port} (/broken/health, /fixed/health)`));
