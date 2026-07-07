import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isValidDomain,
  parseDomainList,
} from "../../tools/compiler/dist/parse.js";

test("parses, dedupes, lowercases and sorts domains", () => {
  const r = parseDomainList(
    "# comment\nB-Example.com\na.example.org # trailing comment\n\nb-example.com\n",
    "t.txt",
  );
  assert.ok(r.ok);
  assert.deepEqual(r.value, ["a.example.org", "b-example.com"]);
});

test("invalid domain is a hard error with file and line", () => {
  const r = parseDomainList("good.example\nhttp://bad.example/path\n", "t.txt");
  assert.ok(!r.ok);
  assert.equal(r.error[0]?.kind, "invalid-domain");
  assert.equal(r.error[0]?.line, 2);
});

test("empty source file is an error, not an empty ruleset", () => {
  const r = parseDomainList("# only comments\n", "t.txt");
  assert.ok(!r.ok);
  assert.equal(r.error[0]?.kind, "empty-category");
});

test("domain validation", () => {
  assert.ok(isValidDomain("example.com"));
  assert.ok(isValidDomain("xn--mgbh0fb.example"));
  assert.ok(!isValidDomain("example"));
  assert.ok(!isValidDomain("*.example.com"));
  assert.ok(!isValidDomain("exa mple.com"));
  assert.ok(!isValidDomain("-bad.example.com"));
});
