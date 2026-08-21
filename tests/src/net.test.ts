import assert from "node:assert/strict";
import { test } from "node:test";

import { clientIp } from "../../server/sync/dist/net.js";

test("without the trusted-proxy flag, X-Forwarded-For is ignored entirely", () => {
  assert.equal(clientIp("198.51.100.4", "1.2.3.4", false), "198.51.100.4");
  assert.equal(clientIp("198.51.100.4", "1.2.3.4, 5.6.7.8", false), "198.51.100.4");
  assert.equal(clientIp(undefined, "1.2.3.4", false), "unknown");
});

test("with the flag, the LAST entry wins — the hop our own proxy appended", () => {
  assert.equal(clientIp("127.0.0.1", "1.2.3.4", true), "1.2.3.4");
  // A spoofing client sends its own XFF; the proxy appends the real IP last.
  assert.equal(clientIp("127.0.0.1", "6.6.6.6, 203.0.113.9", true), "203.0.113.9");
  assert.equal(
    clientIp("127.0.0.1", ["6.6.6.6", "203.0.113.9"], true),
    "203.0.113.9",
  );
});

test("with the flag but no header, falls back to the socket address", () => {
  assert.equal(clientIp("198.51.100.4", undefined, true), "198.51.100.4");
  assert.equal(clientIp("198.51.100.4", "  ,  ", true), "198.51.100.4");
  assert.equal(clientIp(undefined, undefined, true), "unknown");
});

test("entries are trimmed", () => {
  assert.equal(clientIp("127.0.0.1", " 1.2.3.4 ,  2001:db8::7 ", true), "2001:db8::7");
});
