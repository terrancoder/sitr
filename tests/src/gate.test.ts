import assert from "node:assert/strict";
import { test } from "node:test";

import { gateMutation } from "../../extension/dist/lib/gate.js";
import {
  EMPTY_MANAGED_POLICY,
  sanitizeManagedPolicy,
} from "../../extension/dist/lib/managed.js";

const LOCKED = sanitizeManagedPolicy({ lockOptions: true });

const ALL_KINDS = [
  "disableCategory",
  "removeDeviceBlockRule",
  "addDeviceAllowRule",
  "removeHouseholdRule",
  "leaveHousehold",
  "enableCategory",
  "addDeviceBlockRule",
  "removeDeviceAllowRule",
  "addHouseholdRule",
  "changePin",
] as const;

test("managed lockOptions forbids every mutation for every role", () => {
  for (const kind of ALL_KINDS) {
    for (const role of ["guardian", "child", undefined] as const) {
      const v = gateMutation(kind, { managed: LOCKED, role, hasPin: true });
      assert.deepEqual(v, { allowed: false, reason: "managed-locked" }, `${kind}/${String(role)}`);
    }
  }
});

test("child devices may only tighten their own device rules", () => {
  const ctx = { managed: EMPTY_MANAGED_POLICY, role: "child" as const, hasPin: true };
  const allowed = ["enableCategory", "addDeviceBlockRule", "removeDeviceAllowRule"] as const;
  for (const kind of allowed) {
    assert.deepEqual(gateMutation(kind, ctx), { allowed: true, requiresPin: false }, kind);
  }
  for (const kind of ALL_KINDS.filter((k) => !(allowed as readonly string[]).includes(k))) {
    assert.deepEqual(gateMutation(kind, ctx), { allowed: false, reason: "child-device" }, kind);
  }
});

test("guardian with PIN: loosening actions and changePin require it", () => {
  const ctx = { managed: EMPTY_MANAGED_POLICY, role: "guardian" as const, hasPin: true };
  const gated = [
    "disableCategory",
    "removeDeviceBlockRule",
    "addDeviceAllowRule",
    "removeHouseholdRule",
    "leaveHousehold",
    "changePin",
  ] as const;
  for (const kind of gated) {
    assert.deepEqual(gateMutation(kind, ctx), { allowed: true, requiresPin: true }, kind);
  }
  for (const kind of ["enableCategory", "addDeviceBlockRule", "addHouseholdRule"] as const) {
    assert.deepEqual(gateMutation(kind, ctx), { allowed: true, requiresPin: false }, kind);
  }
});

test("no PIN set: everything is allowed without ceremony (and no household role)", () => {
  for (const kind of ALL_KINDS) {
    const v = gateMutation(kind, {
      managed: EMPTY_MANAGED_POLICY,
      role: undefined,
      hasPin: false,
    });
    assert.deepEqual(v, { allowed: true, requiresPin: false }, kind);
  }
});
