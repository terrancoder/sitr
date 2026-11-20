/**
 * Conformance fixture replay — the reference implementation must pass the
 * COMMITTED fixtures in apps/shared/fixtures forever, not just at the
 * moment they were generated. The Swift and Kotlin ports replay the same
 * files in their own suites; this test is what keeps all three
 * implementations pinned to one behavior.
 *
 * Regenerate with `npm run fixtures` (CI diffs the result).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  crc16,
  decodePairingCode,
  deriveKeys,
  encodePairingCode,
  openState,
  toHex,
} from "../../extension/dist/lib/sync/crypto.js";
import {
  mergeStates,
  sanitizeHouseholdState,
  type HouseholdState,
} from "../../extension/dist/lib/household.js";
import {
  LEAVE_JOIN_PLACEHOLDER_GATED_AS,
  FAMILY_CODE_GATED_AS,
  gateMutation,
  type MutationKind,
  type HouseholdRole,
} from "../../extension/dist/lib/gate.js";
import { EMPTY_MANAGED_POLICY } from "../../extension/dist/lib/managed.js";
import {
  DELAY_MINUTES,
  JOIN_HOUSEHOLD_WAITS_AS,
  SHORTEN_DELAY_GATED_AS,
  WINDOW_MS,
  decideMutation,
  delayChangeAction,
  evaluate,
  needsWait,
  type DelayAction,
} from "../../extension/dist/lib/delay.js";
import {
  backoffAfterFailure,
  hashPin,
  verifyPin,
  type PinRecord,
} from "../../extension/dist/lib/pin.js";
import { EntitlementChecker, checkToken as check } from "../../server/sync/dist/entitlement.js";
import {
  FIRST_BACKOFF_MS,
  LEGACY_DAYS,
  MAX_BACKOFF_MS,
  claimOutcome,
  classifyCodeInput,
  created,
  forcesWrite,
  forgetClaims,
  next,
  normalizeSubscriptionCode,
  notice,
  observe,
  offersReplace,
  parseToken,
  record,
  retriesCreate,
  sanitizeClaimState,
  tokenToSend,
  userRetry,
  type ClaimState,
} from "../../extension/dist/lib/entitlement.js";
import { DAY, HOUR, parseSyncRefusal } from "../../extension/dist/lib/householdEnd.js";

const fixture = (name: string): any =>
  JSON.parse(
    readFileSync(
      new URL(`../../apps/shared/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)?.map((b: string) => parseInt(b, 16)) ?? []);

const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

test("hkdf fixture: derivations match for every committed case", async () => {
  const fx = fixture("hkdf.json");
  assert.ok(fx.cases.length >= 4);
  for (const c of fx.cases) {
    const keys = await deriveKeys(fromHex(c.rootSecretHex));
    assert.ok(keys.ok, c.name);
    assert.equal(keys.value.authToken, c.authTokenHex, c.name);
    assert.equal(keys.value.householdId, c.householdIdHex, c.name);

    // encKeyHex: prove the committed bytes are the reference's actual key by
    // sealing a probe with them and opening it with the reference-derived key.
    const imported = await crypto.subtle.importKey(
      "raw",
      fromHex(c.encKeyHex) as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const nonce = new Uint8Array(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce as BufferSource,
          additionalData: new TextEncoder().encode("sitr-sync v1") as BufferSource,
        },
        imported,
        new TextEncoder().encode(
          JSON.stringify({ v: 1, rev: 1 }),
        ) as BufferSource,
      ),
    );
    const probe = new Uint8Array(1 + 12 + ct.length);
    probe[0] = 0x01;
    probe.set(nonce, 1);
    probe.set(ct, 13);
    const opened = await openState(probe, keys.value.encKey);
    assert.ok(opened.ok, `${c.name}: committed encKeyHex must match the reference key`);
  }
  for (const c of fx.invalid) {
    assert.ok(!(await deriveKeys(fromHex(c.rootSecretHex))).ok, c.name);
  }
});

test("blob fixture: golden opens byte-exactly and errors stay errors", async () => {
  const fx = fixture("blob.json");
  const keys = await deriveKeys(fromHex(fx.golden.rootSecretHex));
  assert.ok(keys.ok);
  const opened = await openState(fromB64(fx.golden.blobB64), keys.value.encKey);
  assert.ok(opened.ok);
  assert.deepEqual(opened.value, fx.golden.stateJson);
  assert.equal(JSON.stringify(fx.golden.stateJson), fx.golden.plaintextUtf8);

  for (const e of fx.errors) {
    const k =
      e.rootSecretHex !== undefined
        ? await deriveKeys(fromHex(e.rootSecretHex))
        : keys;
    assert.ok(k.ok);
    const r = await openState(fromB64(e.blobB64), k.value.encKey);
    assert.ok(!r.ok, e.name);
  }
});

test("pairing fixture: canonical codes, forgiveness, and rejections", () => {
  const fx = fixture("pairing.json");
  for (const c of fx.canonical) {
    assert.equal(encodePairingCode(fromHex(c.rootSecretHex)), c.code, c.name);
    const back = decodePairingCode(c.code);
    assert.ok(back.ok, c.name);
    assert.equal(toHex(back.value), c.rootSecretHex, c.name);
  }
  for (const c of fx.decodeOk) {
    const back = decodePairingCode(c.code);
    assert.ok(back.ok, c.name);
    assert.equal(toHex(back.value), c.rootSecretHex, c.name);
  }
  for (const c of fx.decodeError) {
    assert.ok(!decodePairingCode(c.code).ok, c.name);
  }
});

test("crc16 fixture", () => {
  const fx = fixture("crc16.json");
  for (const c of fx.cases) {
    assert.equal(
      crc16(fromHex(c.inputHex)).toString(16).padStart(4, "0"),
      c.crcHex,
      c.name,
    );
  }
});

test("merge fixture: LWW winners", () => {
  const fx = fixture("merge.json");
  for (const c of fx.cases) {
    const winner = mergeStates(c.a as HouseholdState, c.b as HouseholdState);
    assert.deepEqual(winner, c.winner === "a" ? c.a : c.b, c.name);
  }
});

test("gate fixture: exhaustive authority table", () => {
  const fx = fixture("gate.json");
  // 2 lock × 3 role × 2 pin × 14 mutation kinds. The Swift and Kotlin
  // replays derive the same count from their enums.
  assert.equal(fx.cases.length, 168);
  for (const c of fx.cases) {
    const verdict = gateMutation(c.kind as MutationKind, {
      managed: { ...EMPTY_MANAGED_POLICY, lockOptions: c.managedLockOptions },
      role: (c.role ?? undefined) as HouseholdRole | undefined,
      hasPin: c.hasPin,
    });
    assert.deepEqual(verdict, c.verdict, `${c.kind} / ${JSON.stringify(c)}`);
  }
});

test("gate fixture: leaving a join placeholder is gated as leaveJoinPlaceholderGatedAs", () => {
  const fx = fixture("gate.json");
  assert.equal(fx.leaveJoinPlaceholderGatedAs, "enableCategory");
  assert.equal(fx.leaveJoinPlaceholderGatedAs, LEAVE_JOIN_PLACEHOLDER_GATED_AS);
  const rows = fx.cases.filter((c: { kind: string }) => c.kind === fx.leaveJoinPlaceholderGatedAs);
  assert.equal(rows.length, 12);
  for (const c of rows) {
    const ctx = {
      managed: { ...EMPTY_MANAGED_POLICY, lockOptions: c.managedLockOptions },
      role: (c.role ?? undefined) as HouseholdRole | undefined,
      hasPin: c.hasPin,
    };
    // Managed lock refuses; otherwise go: no PIN, no wait, in every phase.
    const expected = c.managedLockOptions
      ? { step: "refused", reason: "managed-locked" }
      : { step: "go" };
    assert.deepEqual(c.verdict.allowed ? { step: "go" } : { step: "refused", reason: c.verdict.reason }, expected);
    for (const phase of ["off", "idle", "waiting", "open"] as const) {
      assert.deepEqual(decideMutation("leaveJoinPlaceholder", ctx, phase), expected, JSON.stringify(c));
    }
  }
});

test("gate fixture: a subscription code is gated as subscriptionGatedAs", () => {
  const fx = fixture("gate.json");
  assert.equal(fx.subscriptionGatedAs, "changePin");
  assert.equal(fx.subscriptionGatedAs, FAMILY_CODE_GATED_AS);
  const rows = fx.cases.filter((c: { kind: string }) => c.kind === fx.subscriptionGatedAs);
  assert.equal(rows.length, 12);
  for (const c of rows) {
    // Refused under a managed lock and on a child device; otherwise the
    // PIN exactly when one is set; never a wait.
    const expected = c.managedLockOptions
      ? { allowed: false, reason: "managed-locked" }
      : c.role === "child"
        ? { allowed: false, reason: "child-device" }
        : { allowed: true, requiresPin: c.hasPin };
    assert.deepEqual(c.verdict, expected, JSON.stringify(c));
  }
  for (const phase of ["off", "idle", "waiting", "open"] as const) {
    assert.equal(needsWait(fx.subscriptionGatedAs, phase), false);
  }
});

test("delay fixture: evaluate, needsWait and changing the delay", () => {
  const fx = fixture("delay.json");
  assert.deepEqual(fx.delayMinutesAllowed, [...DELAY_MINUTES]);
  assert.equal(fx.windowMs, WINDOW_MS);
  assert.equal(fx.shortenDelayGatedAs, SHORTEN_DELAY_GATED_AS);
  assert.equal(fx.joinHouseholdWaitsAs, "disableCategory");
  assert.equal(fx.joinHouseholdWaitsAs, JOIN_HOUSEHOLD_WAITS_AS);
  // 6 delays x 14 clock cases; 15 actions (14 kinds + shortenDelay) x 4
  // phases; delay changes: 5 from off (phase off) + 5 x 5 x 3 phases.
  assert.equal(fx.evaluate.length, 84);
  assert.equal(fx.needsWait.length, 60);
  assert.equal(fx.delayChange.length, 80);
  for (const c of fx.evaluate) {
    assert.deepEqual(evaluate(c.delayMinutes, c.request, c.now), c.result, c.name);
  }
  for (const c of fx.needsWait) {
    assert.equal(needsWait(c.action as DelayAction, c.phase), c.needsWait, `${c.action}/${c.phase}`);
  }
  for (const c of fx.delayChange) {
    const action = delayChangeAction(c.fromMinutes, c.toMinutes);
    assert.equal(action, c.action, JSON.stringify(c));
    assert.equal(action !== null && needsWait(action, c.phase), c.needsWait, JSON.stringify(c));
  }
});

test("sanitize fixture: total validator behavior", () => {
  const fx = fixture("sanitize.json");
  for (const c of fx.cases) {
    const r = sanitizeHouseholdState(c.raw);
    assert.equal(r.ok, c.ok, c.name);
    if (r.ok) assert.deepEqual(r.value, c.sanitized, c.name);
  }
});

test("pin fixture: fixed-salt golden hash, verify, and backoff schedule", async () => {
  const fx = fixture("pin.json");
  const g = fx.golden;
  const hash = await hashPin(g.pin, fromHex(g.saltHex), g.iterations);
  assert.equal(toHex(hash), g.hashHex);
  assert.ok(await verifyPin(g.pin, g.record as PinRecord));
  assert.ok(!(await verifyPin(g.wrongPin, g.record as PinRecord)));
  for (const c of fx.backoff) {
    assert.deepEqual(backoffAfterFailure(c.priorCount, c.now), c.after);
  }
});

test("entitlement fixture: verification outcomes with the committed test key", () => {
  const fx = fixture("entitlement.json");
  const checker = new EntitlementChecker(fx.publicKeyB64);
  const open = new EntitlementChecker(undefined);
  for (const c of fx.cases) {
    const header = c.token === "" ? undefined : c.token;
    assert.equal(check(checker, header, fx.now).kind, c.outcome, c.name);
    assert.equal(check(open, header, fx.now).kind, "ok", c.name);
  }
});

test("claim fixture: tokens, the code field, claim answers and sync 402 reasons", () => {
  const fx = fixture("claim.json");
  assert.deepEqual(fx.constants, {
    dayMs: DAY,
    hourMs: HOUR,
    firstBackoffMs: FIRST_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    windowOpensDaysBeforeE: 10,
    windowNoDelayDaysBeforeE: 5,
    noticeDaysBeforeE: 2,
    legacyDays: LEGACY_DAYS,
  });
  for (const c of fx.tokens) assert.deepEqual(parseToken(c.raw), c.parsed, c.name);
  for (const c of fx.codeInput) {
    assert.equal(normalizeSubscriptionCode(c.input), c.normalized, c.name);
    assert.deepEqual(classifyCodeInput(c.input), c.classified, c.name);
  }
  for (const c of fx.claimOutcomes) assert.deepEqual(claimOutcome(c.status, c.body), c.outcome, c.name);
  for (const c of fx.syncRefusals) {
    const r = parseSyncRefusal(c.status, c.body);
    assert.equal(r, c.refusal, c.name);
    assert.equal(r !== null && retriesCreate(r), c.retriesCreate, c.name);
  }
});

test("claim fixture: every scenario step gives the committed decision and state", () => {
  const fx = fixture("claim.json");
  assert.ok(fx.scenarios.length >= 30);
  for (const sc of fx.scenarios) {
    for (const [i, st] of sc.steps.entries()) {
      const label = `${sc.name} — step ${i}`;
      // The committed state is already in stored form.
      const state: ClaimState = sanitizeClaimState(st.state);
      assert.deepEqual(state, st.state, label);
      const e = st.event;
      let after: ClaimState;
      let decision = null;
      switch (e.type) {
        case "next": {
          const r = next(state, st.now, e.householdId, () => {
            assert.notEqual(st.random, null, `${label}: draws a random value`);
            return st.random;
          });
          decision = r.decision;
          after = r.state;
          break;
        }
        case "record":
          after = record(state, e.outcome, e.current, st.now);
          break;
        case "observe":
          after = observe(state, e.answer, e.householdId, st.now);
          break;
        case "created":
          after = created(state, e.token, e.householdId, e.entExp);
          break;
        case "userRetry":
          after = userRetry(state);
          break;
        case "forgetClaims":
          after = forgetClaims(state);
          break;
        default:
          throw new Error(`${label}: unknown event ${e.type}`);
      }
      assert.deepEqual(decision, st.decision, label);
      assert.deepEqual(
        {
          state: after,
          notice: notice(after, st.now, sc.holdsCode),
          offersReplace: offersReplace(after, st.now),
          tokenToSend: tokenToSend(after)?.raw ?? null,
          forcesWrite: forcesWrite(after),
        },
        st.result,
        label,
      );
    }
  }
});
