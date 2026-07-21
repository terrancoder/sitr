/**
 * Entry point: node:http wiring around SyncHandler + hourly GC.
 * Run behind TLS (Caddy or similar); see server/sync/README.md.
 */
import { createServer } from "node:http";
import { configFromEnv } from "./config.js";
import { SyncStore } from "./store.js";
import { SyncHandler, type SyncRequest } from "./http.js";

const config = configFromEnv(process.env);
const store = new SyncStore(config.dbPath);
const handler = new SyncHandler(store, config);

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > config.maxBlobBytes + 1024) {
      res.writeHead(413, { "Cache-Control": "no-store" });
      res.end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    const request: SyncRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      ip: req.socket.remoteAddress ?? "unknown",
      headers: {
        authorization: req.headers.authorization,
        "if-match": req.headers["if-match"],
        "if-none-match": req.headers["if-none-match"],
        "x-sitr-entitlement": Array.isArray(req.headers["x-sitr-entitlement"])
          ? req.headers["x-sitr-entitlement"][0]
          : req.headers["x-sitr-entitlement"],
      },
      body: new Uint8Array(Buffer.concat(chunks)),
    };
    const response = handler.handle(request);
    res.writeHead(response.status, response.headers);
    res.end(Buffer.from(response.body));
  });
});

setInterval(
  () => {
    store.gc(Date.now(), config.idleExpiryMs);
  },
  60 * 60 * 1000,
).unref();

server.listen(config.port, () => {
  // Startup line only — the server never logs requests.
  console.log(`sitr-sync listening on :${config.port}`);
});
