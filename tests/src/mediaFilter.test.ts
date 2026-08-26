import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GREYLIST_RULESET,
  MEDIA_ALL_RULESET,
  isMediaModeLoosening,
  mediaRulesets,
  sanitizeMediaMode,
} from "../../extension/dist/lib/categories.js";
import { effectiveRequiredRulesets } from "../../extension/dist/lib/managed.js";
import { gateMutation } from "../../extension/dist/lib/gate.js";
import { EMPTY_MANAGED_POLICY } from "../../extension/dist/lib/managed.js";
import {
  IMAGE_ALLOW_BASE,
  IMAGE_ALLOW_PRIORITY,
  LAYER_BAND_WIDTH,
  LAYER_BASES,
  MAX_IMAGE_ALLOW_RULES,
  MAX_RULES_PER_LAYER_KIND,
  MAX_SESSION_ESCAPE_RULES,
  SESSION_ESCAPE_BASE,
  buildImageAllowRule,
  buildLayerRule,
  imageAllowSitesOf,
  isImageAllowId,
  layerKindOf,
  planImageAllowUpdate,
  planLayerUpdate,
} from "../../extension/dist/lib/ruleLayers.js";
import {
  STATIC_CATEGORY_PRIORITY,
} from "../../tools/compiler/dist/compile.js";
import { MEDIA_FILTER_PRIORITY } from "../../tools/compiler/dist/greylist.js";

/* ------------------------------- mode model ------------------------------- */

test("sanitizeMediaMode degrades anything unknown to off", () => {
  assert.equal(sanitizeMediaMode("greylist"), "greylist");
  assert.equal(sanitizeMediaMode("allowlist"), "allowlist");
  assert.equal(sanitizeMediaMode("off"), "off");
  assert.equal(sanitizeMediaMode("strict"), "off");
  assert.equal(sanitizeMediaMode(undefined), "off");
  assert.equal(sanitizeMediaMode(42), "off");
});

test("mediaRulesets maps each mode to exactly its ruleset", () => {
  assert.deepEqual(mediaRulesets("off"), []);
  assert.deepEqual(mediaRulesets("greylist"), [GREYLIST_RULESET]);
  assert.deepEqual(mediaRulesets("allowlist"), [MEDIA_ALL_RULESET]);
});

test("loosening matrix: any step toward less filtering is loosening", () => {
  const modes = ["off", "greylist", "allowlist"] as const;
  const strictness = { off: 0, greylist: 1, allowlist: 2 };
  for (const from of modes) {
    for (const to of modes) {
      assert.equal(
        isMediaModeLoosening(from, to),
        strictness[to] < strictness[from],
        `${from} -> ${to}`,
      );
    }
  }
});

test("effectiveRequiredRulesets requires the mode's ruleset; default is off", () => {
  assert.ok(!effectiveRequiredRulesets([], [], []).includes(GREYLIST_RULESET));
  assert.ok(
    effectiveRequiredRulesets([], [], [], "greylist").includes(GREYLIST_RULESET),
  );
  const allowlist = effectiveRequiredRulesets([], [], [], "allowlist");
  assert.ok(allowlist.includes(MEDIA_ALL_RULESET));
  assert.ok(!allowlist.includes(GREYLIST_RULESET));
  // The media mode never affects the category rulesets.
  assert.ok(allowlist.includes("sitr_adult"));
});

/* --------------------------------- gate ---------------------------------- */

test("gate: loosening media actions are PIN-gated and child-refused", () => {
  for (const kind of ["loosenMediaMode", "addImageAllowRule"] as const) {
    const pinned = gateMutation(kind, {
      managed: EMPTY_MANAGED_POLICY,
      role: undefined,
      hasPin: true,
    });
    assert.deepEqual(pinned, { allowed: true, requiresPin: true }, kind);
    const child = gateMutation(kind, {
      managed: EMPTY_MANAGED_POLICY,
      role: "child",
      hasPin: false,
    });
    assert.deepEqual(child, { allowed: false, reason: "child-device" }, kind);
  }
  for (const kind of ["tightenMediaMode", "removeImageAllowRule"] as const) {
    const verdict = gateMutation(kind, {
      managed: EMPTY_MANAGED_POLICY,
      role: "child",
      hasPin: true,
    });
    assert.deepEqual(verdict, { allowed: true, requiresPin: false }, kind);
  }
});

/* ----------------------------- priority ladder ---------------------------- */

test("ladder: media blocks < image allow < static categories < user block", () => {
  assert.ok(MEDIA_FILTER_PRIORITY < IMAGE_ALLOW_PRIORITY);
  assert.ok(IMAGE_ALLOW_PRIORITY < STATIC_CATEGORY_PRIORITY);
  assert.ok(
    STATIC_CATEGORY_PRIORITY <
      buildLayerRule("user", "block", "a.example", LAYER_BASES.user.block)
        .priority,
  );
});

test("budget: bands + image allowlist + session headroom fit Safari's 30k pool", () => {
  assert.equal(
    6 * MAX_RULES_PER_LAYER_KIND +
      MAX_IMAGE_ALLOW_RULES +
      MAX_SESSION_ESCAPE_RULES,
    30_000,
  );
});

test("image-allow band never overlaps the layer or session bands", () => {
  for (const layer of ["user", "household", "managed"] as const) {
    for (const kind of ["allow", "block"] as const) {
      const base = LAYER_BASES[layer][kind];
      assert.ok(
        base + LAYER_BAND_WIDTH <= IMAGE_ALLOW_BASE ||
          IMAGE_ALLOW_BASE + LAYER_BAND_WIDTH <= base,
      );
    }
  }
  assert.ok(IMAGE_ALLOW_BASE + LAYER_BAND_WIDTH <= SESSION_ESCAPE_BASE);
  assert.equal(layerKindOf(IMAGE_ALLOW_BASE), undefined);
  assert.ok(isImageAllowId(IMAGE_ALLOW_BASE));
  assert.ok(!isImageAllowId(SESSION_ESCAPE_BASE));
});

/* ----------------------- migration: pre-re-slice ids ----------------------- */

test("rules created under the old 5,000 cap are still recognized and removable", () => {
  // An install predating the re-slice can hold ids at offsets 4,500-4,999.
  const oldId = LAYER_BASES.user.allow + 4_700;
  assert.deepEqual(layerKindOf(oldId), { layer: "user", kind: "allow" });
  const live = [buildLayerRule("user", "allow", "legacy.example", oldId)];
  const r = planLayerUpdate(live, "user", "allow", []);
  assert.ok(r.ok);
  assert.deepEqual(r.value.removeRuleIds, [oldId]);
});

/* ---------------------------- image-allow plans ---------------------------- */

test("buildImageAllowRule is initiator-scoped and image+media only", () => {
  const rule = buildImageAllowRule("example.com", IMAGE_ALLOW_BASE);
  assert.equal(rule.priority, IMAGE_ALLOW_PRIORITY);
  assert.equal(rule.action.type, "allow");
  assert.deepEqual(rule.condition.initiatorDomains, ["example.com"]);
  assert.equal(rule.condition.requestDomains, undefined);
  assert.deepEqual(rule.condition.resourceTypes, ["image", "media"]);
  assert.ok(!rule.condition.resourceTypes.includes("main_frame"));
});

test("planImageAllowUpdate reconciles and leaves the layer bands alone", () => {
  const live = [
    buildImageAllowRule("old.example", IMAGE_ALLOW_BASE),
    buildImageAllowRule("keep.example", IMAGE_ALLOW_BASE + 1),
    buildLayerRule("user", "allow", "user.example", LAYER_BASES.user.allow),
  ];
  const r = planImageAllowUpdate(live, ["keep.example", "new.example"]);
  assert.ok(r.ok);
  assert.deepEqual(r.value.removeRuleIds, [IMAGE_ALLOW_BASE]);
  assert.equal(r.value.addRules.length, 1);
  assert.deepEqual(r.value.addRules[0]!.condition.initiatorDomains, [
    "new.example",
  ]);
  assert.equal(r.value.addRules[0]!.id, IMAGE_ALLOW_BASE);
});

test("planImageAllowUpdate is idempotent and surfaces cap overflow", () => {
  const live = [buildImageAllowRule("a.example", IMAGE_ALLOW_BASE)];
  const same = planImageAllowUpdate(live, ["a.example"]);
  assert.ok(same.ok);
  assert.deepEqual(same.value, { addRules: [], removeRuleIds: [] });

  const tooMany = Array.from(
    { length: MAX_IMAGE_ALLOW_RULES + 1 },
    (_, i) => `d${i}.example`,
  );
  const over = planImageAllowUpdate([], tooMany);
  assert.ok(!over.ok);
  assert.match(over.error, /limit/);
});

test("imageAllowSitesOf reads only the image band, sorted", () => {
  const live = [
    buildImageAllowRule("zeta.example", IMAGE_ALLOW_BASE),
    buildImageAllowRule("alpha.example", IMAGE_ALLOW_BASE + 1),
    buildLayerRule("user", "allow", "other.example", LAYER_BASES.user.allow),
  ];
  assert.deepEqual(
    imageAllowSitesOf(live).map((e) => e.domain),
    ["alpha.example", "zeta.example"],
  );
});
