import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_SAFARI_MAJOR,
  SAFESEARCH_ORIGINS,
  safariVersionGate,
} from "../../extension/dist/lib/status.js";

const SAFARI_18 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.3 Safari/605.1.15";
const SAFARI_26 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const EDGE = CHROME + " Edg/139.0.0.0";

test("safari version gate: old Safari is refused with a reason", () => {
  const reason = safariVersionGate(SAFARI_18);
  assert.ok(reason !== null);
  assert.match(reason, new RegExp(String(MIN_SAFARI_MAJOR)));
});

test("safari version gate: Safari 26+ passes", () => {
  assert.equal(safariVersionGate(SAFARI_26), null);
});

test("safari version gate: Chromium UAs are never gated", () => {
  // Chrome/Edge carry "Safari/" but never "Version/" — no false positives.
  assert.equal(safariVersionGate(CHROME), null);
  assert.equal(safariVersionGate(EDGE), null);
});

test("safesearch origins cover exactly the manifest's engine hosts", () => {
  assert.deepEqual(SAFESEARCH_ORIGINS, [
    "*://*.google.com/*",
    "*://www.bing.com/*",
    "*://duckduckgo.com/*",
    "*://*.youtube.com/*",
    "*://youtubei.googleapis.com/*",
  ]);
});
