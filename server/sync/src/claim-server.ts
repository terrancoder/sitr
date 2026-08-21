/**
 * Entry point for the claim service — the ONLY process that holds the
 * Ed25519 minting key (SITR_ENTITLEMENT_PRIVKEY) and the Polar token.
 * Serves nothing but /v1/entitlement/claim/*; the reverse proxy routes
 * that path prefix here and everything else to the sync process
 * (server.ts), which never sees either secret.
 */
import { createServer } from "node:http";
import { configFromEnv } from "./config.js";
import { ClaimHandler } from "./claim.js";
import type { SyncRequest } from "./http.js";
import { clientIp } from "./net.js";

const config = configFromEnv(process.env);
const handler = new ClaimHandler(config);

const server = createServer((req, res) => {
  // Claims are GET/OPTIONS only — the body is read and discarded so
  // misbehaving clients cannot wedge the socket.
  req.resume();
  req.on("end", () => {
    const request: SyncRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      ip: clientIp(
        req.socket.remoteAddress,
        req.headers["x-forwarded-for"],
        config.trustedProxy,
      ),
      headers: {},
      body: new Uint8Array(0),
    };
    void handler.handleClaim(request).then((response) => {
      res.writeHead(response.status, response.headers);
      res.end(Buffer.from(response.body));
    });
  });
});

server.listen(config.claimPort, () => {
  // Startup line only — the server never logs requests.
  console.log(`sitr-claim listening on :${config.claimPort}`);
});
