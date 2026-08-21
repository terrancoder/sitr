import assert from "node:assert/strict";
import { test } from "node:test";

import {
  safesearchHostsMap,
  serializeDomainList,
  serializeSafesearchHosts,
} from "../../tools/compiler/dist/emitAndroid.js";

test("golden: domain list serializes one per line with trailing newline", () => {
  assert.equal(
    serializeDomainList(["a.example", "b.example"]),
    "a.example\nb.example\n",
  );
});

test("deterministic: same input twice gives identical output", () => {
  const domains = ["a.example", "m.example", "z.example"];
  assert.equal(serializeDomainList(domains), serializeDomainList(domains));
  assert.equal(
    serializeSafesearchHosts(safesearchHostsMap()),
    serializeSafesearchHosts(safesearchHostsMap()),
  );
});

test("safesearch host map covers all four engines with targets", () => {
  const map = safesearchHostsMap();
  assert.equal(map.v, 1);
  const targets = map.rules.map((r) => r.target);
  assert.deepEqual(targets, [
    "forcesafesearch.google.com",
    "strict.bing.com",
    "safe.duckduckgo.com",
    "restrict.youtube.com",
  ]);
  for (const rule of map.rules) {
    assert.ok(rule.match.length > 0);
    assert.ok(Array.isArray(rule.fallback.a));
    assert.ok(Array.isArray(rule.fallback.aaaa));
  }
});

test("wildcard patterns appear only where ccTLD matching is intended", () => {
  const map = safesearchHostsMap();
  for (const rule of map.rules) {
    for (const pattern of rule.match) {
      if (pattern.includes("*")) {
        // Only the documented form: a hostname ending in ".*" (Google ccTLDs).
        assert.match(pattern, /^[a-z0-9.-]+\.\*$/);
        assert.match(rule.target, /google/);
      }
    }
  }
});

test("serialization is stable-style JSON with trailing newline", () => {
  const body = serializeSafesearchHosts(safesearchHostsMap());
  assert.ok(body.endsWith("}\n"));
  assert.equal(body, JSON.stringify(JSON.parse(body), null, 2) + "\n");
});
