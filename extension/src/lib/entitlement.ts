/**
 * Sitr Family entitlement, version 2, on the client
 * (docs/sync-protocol.md §Entitlement version 2, §What each client must do).
 *
 * Pure: no fetch, no chrome.*, no storage. Time and randomness are passed
 * in. The claim state is JSON with the field names of the iOS app's
 * ClaimState (apps/ios/SitrCore/Sources/SitrCore/Entitlement.swift), so the
 * three platforms store the same shape and replay the same fixture
 * (apps/shared/fixtures/claim.json).
 *
 * The caller's part, not expressible here: claim only while this device
 * holds a subscription code (a child-role device never does); the creation
 * flow claims by rule (a), offers "Renew on this device" on any
 * bound-to-other-device answer, and on token-used / token-expired /
 * token-invalid / token-required claims once more and retries the creation
 * once (retriesCreate). Entering or removing the code applies forgetClaims;
 * leaving the household starts from emptyClaimState().
 *
 * Full channel only: the Safari App Store staging leaves this module out.
 * What a member device needs without a code is in householdEnd.ts.
 */
import {
  DAY,
  HOUR,
  WAITING_TEXT,
  endNotice,
  isLapsed,
  observeEnd,
  showsOpen,
  type EndAnswer,
  type SyncRefusal,
} from "./householdEnd.js";
/** Backoff after 429, 5xx, no network: 5 minutes, doubling, at most 6 hours. */
export const FIRST_BACKOFF_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 6 * HOUR;
/** A household whose E is further away than this is a legacy household
 * after the cut-over is announced (no token reaches further). */
export const LEGACY_DAYS = 41;

/* -------------------------------- token --------------------------------- */

/** A version 2 token as the client reads it. The client never checks the
 * signature and never judges a token by its own clock (§Clocks); it reads
 * `per` and `exp` only to order and retire held tokens. */
export interface EntitlementToken {
  raw: string;
  plan: string;
  term: string;
  per: number;
  exp: number;
  test: boolean;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeB64urlJson(part: string): unknown {
  if (!B64URL.test(part) || part.length % 4 === 1) return undefined;
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** `sitr-ent-v2.<payload>.<signature>` with `v: 2`, string `plan` and
 * `term`, integer `per` and `exp`; `test` is true only when it is `true`.
 * Anything else: null. */
export function parseToken(raw: string): EntitlementToken | null {
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "sitr-ent-v2") return null;
  const p = decodeB64urlJson(parts[1] ?? "");
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (
    o.v !== 2 ||
    typeof o.plan !== "string" ||
    typeof o.term !== "string" ||
    !Number.isSafeInteger(o.per) ||
    !Number.isSafeInteger(o.exp)
  ) {
    return null;
  }
  return {
    raw,
    plan: o.plan,
    term: o.term,
    per: o.per as number,
    exp: o.exp as number,
    test: o.test === true,
  };
}

/** A version 1 token by its shape alone: `sitr-ent-v1.<payload>.<signature>`. */
export function isVersion1Token(raw: string): boolean {
  return /^sitr-ent-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw);
}

/** The claim service's own check (server/sync/src/claim.ts UUID_RE): any
 * UUID version, canonical 36-character form, RFC 4122 variant, any case. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The subscription code in lower case, or null when it is not one. */
export function normalizeSubscriptionCode(input: string): string | null {
  return UUID_RE.test(input) ? input.toLowerCase() : null;
}

export type CodeInput =
  | { kind: "code"; code: string }
  | { kind: "v1-token"; token: string }
  | { kind: "invalid" };

/** The one input field (§One input field): a subscription code or a version
 * 1 token, told apart by shape after trimming; anything else is refused on
 * the device and sends nothing. */
export function classifyCodeInput(input: string): CodeInput {
  const s = input.trim();
  const code = normalizeSubscriptionCode(s);
  if (code !== null) return { kind: "code", code };
  if (isVersion1Token(s)) return { kind: "v1-token", token: s };
  return { kind: "invalid" };
}

/* ----------------------------- claim answers ---------------------------- */

/** The claim service's refusal reasons that the client acts on. */
export type ClaimReason =
  | "bound-to-other-device"
  | "replacement-used"
  | "payment-pending"
  | "inactive"
  | "revoked"
  | "unknown-code"
  | "wrong-product"
  | "invalid-receipt"
  | "test-purchase"
  | "family-sharing"
  | "bad-request"
  /** Any other reason the service sends with a 4xx: stop until the user acts. */
  | "unrecognized";

export const CLAIM_REASONS: readonly ClaimReason[] = [
  "bound-to-other-device",
  "replacement-used",
  "payment-pending",
  "inactive",
  "revoked",
  "unknown-code",
  "wrong-product",
  "invalid-receipt",
  "test-purchase",
  "family-sharing",
  "bad-request",
  "unrecognized",
];

/** "Show the reason and stop until the user acts." */
const STOPS: ReadonlySet<ClaimReason> = new Set([
  "unknown-code",
  "wrong-product",
  "invalid-receipt",
  "test-purchase",
  "family-sharing",
  "bad-request",
  "unrecognized",
]);

export type ClaimOutcome =
  | { kind: "token"; token: EntitlementToken }
  /** A token whose plan is not `family` (§A code of an Institutions plan):
   * delete the code, the claim secret and the token; create nothing. */
  | { kind: "not-family"; plan: string }
  | { kind: "refused"; reason: ClaimReason; retryAfter: number | null }
  /** 429, 5xx, no network, or an answer that is not the claim API's JSON:
   * retry at later runs with backoff. */
  | { kind: "unavailable" };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Maps a claim answer to an outcome. `body` is null when no answer came
 * (no network, no such host). */
export function claimOutcome(status: number, body: string | null): ClaimOutcome {
  if (body === null || status === 429 || status >= 500) return { kind: "unavailable" };
  const json = parseJson(body);
  if (status === 200) {
    const token = isObject(json) && typeof json.token === "string" ? parseToken(json.token) : null;
    if (token === null) return { kind: "unavailable" };
    return token.plan === "family" ? { kind: "token", token } : { kind: "not-family", plan: token.plan };
  }
  if (!isObject(json) || typeof json.error !== "string") return { kind: "unavailable" };
  const reason = (CLAIM_REASONS as readonly string[]).includes(json.error)
    ? (json.error as ClaimReason)
    : "unrecognized";
  const retryAfter = typeof json.retry_after === "number" ? json.retry_after : null;
  return { kind: "refused", reason, retryAfter };
}

/* ---------------------------- sync 402 reasons -------------------------- */

/** On create: claim once more, then retry the creation once. */
export function retriesCreate(refusal: SyncRefusal): boolean {
  return (
    refusal === "token-used" ||
    refusal === "token-expired" ||
    refusal === "token-invalid" ||
    refusal === "token-required"
  );
}

/* ------------------------------ claim state ----------------------------- */

/** What this device remembers about its household's subscription. Never in
 * the household blob. Field names follow the iOS app's ClaimState. */
export interface ClaimState {
  /** Rule (b): the household (id) this device has applied a token to. */
  appliedHousehold: string | null;
  /** The household was created by a `test: true` token. */
  testHousehold: boolean;
  /** `E`, from X-Sitr-Entitlement-Expires; null: no such header (a
   * version 1 household). */
  entExp: number | null;
  /** The renewal window's random first-attempt time, and the E it was
   * drawn for. */
  windowFor: number | null;
  windowAt: number | null;
  /** No automatic claim before this time (daily retry, backoff). */
  notBefore: number | null;
  backoff: number | null;
  /** A refusal that waits for the user. */
  stopped: boolean;
  /** The last refusal this device got; null after a token. */
  lastRefusal: ClaimReason | null;
  /** From replacement-used, for its text. */
  retryAfter: number | null;
  /** A `402 lapsed` was seen and no successful round has shown E > now since. */
  lapsed: boolean;
  /** Rule (d) was answered with a token in this lapse. */
  lapseClaimed: boolean;
  /** Rule (d) was refused as bound-to-other-device in this lapse. */
  lapseRefused: boolean;
  /** Tokens held and not yet covered by E. */
  tokens: EntitlementToken[];
  /** The token already written with a forced write (once per token). */
  forcedToken: string | null;
  /** An E this device saw more than LEGACY_DAYS away (a legacy household's
   * cut-over date). */
  legacyEnd: number | null;
}

export function emptyClaimState(): ClaimState {
  return {
    appliedHousehold: null,
    testHousehold: false,
    entExp: null,
    windowFor: null,
    windowAt: null,
    notBefore: null,
    backoff: null,
    stopped: false,
    lastRefusal: null,
    retryAfter: null,
    lapsed: false,
    lapseClaimed: false,
    lapseRefused: false,
    tokens: [],
    forcedToken: null,
    legacyEnd: null,
  };
}

/** Reads stored JSON. A missing field takes its empty value; a field of the
 * wrong type, or a token that does not parse, yields the empty state (as a
 * failed decode does on iOS). Tokens are re-read from `raw`. */
export function sanitizeClaimState(raw: unknown): ClaimState {
  const empty = emptyClaimState();
  if (!isObject(raw)) return empty;
  const out = emptyClaimState();
  const target = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(empty) as Array<keyof ClaimState>) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const def = empty[key];
    if (key === "tokens") {
      if (!Array.isArray(v)) return empty;
      const tokens: EntitlementToken[] = [];
      for (const t of v) {
        const parsed = isObject(t) && typeof t.raw === "string" ? parseToken(t.raw) : null;
        if (parsed === null) return empty;
        tokens.push(parsed);
      }
      out.tokens = tokens;
    } else if (key === "lastRefusal") {
      if (!(CLAIM_REASONS as readonly unknown[]).includes(v)) return empty;
      out.lastRefusal = v as ClaimReason;
    } else if (key === "appliedHousehold" || key === "forcedToken") {
      if (typeof v !== "string") return empty;
      target[key] = v;
    } else if (typeof def === "boolean") {
      if (typeof v !== "boolean") return empty;
      target[key] = v;
    } else {
      if (typeof v !== "number" || !Number.isFinite(v)) return empty;
      target[key] = v;
    }
  }
  return out;
}

const copy = (s: ClaimState): ClaimState => ({ ...s, tokens: [...s.tokens] });

/** The bound-to-other-device answer is remembered (replacement-used is
 * also an answer that the subscription is bound elsewhere). */
const boundElsewhere = (s: ClaimState): boolean =>
  s.lastRefusal === "bound-to-other-device" || s.lastRefusal === "replacement-used";

/* ------------------------------ when to claim --------------------------- */

export type Decision =
  /** Nothing to do until an answer or a sync round changes the state. */
  | { kind: "none" }
  | { kind: "claim"; replace: false; current: boolean }
  /** No automatic claim before `until`, unless the state changes first. */
  | { kind: "wait"; until: number };

const NONE: Decision = { kind: "none" };
const claim = (current: boolean): Decision => ({ kind: "claim", replace: false, current });
const wait = (until: number): Decision => ({ kind: "wait", until });

/**
 * Rules (b), (c), (d) and the bound-to-other-device rule of §When to claim,
 * for a device that holds a subscription code and is in household
 * `householdId`. `random` is uniform in [0, 1). Returns the decision and the
 * state with the window time drawn.
 */
export function next(
  state: ClaimState,
  now: number,
  householdId: string,
  random: () => number,
): { decision: Decision; state: ClaimState } {
  const s = copy(state);
  const done = (decision: Decision) => ({ decision, state: s });
  if (s.stopped) return done(NONE);
  const lapsed = isLapsed(s, now);
  // Bound elsewhere and E in the future (or no E): no automatic claim at all.
  if (boundElsewhere(s) && !lapsed) return done(NONE);
  if (lapsed) {
    // (d). Wait for the held current token to reach the server; an early
    // token alone, or none (it expired unused), asks again.
    if (s.lapseClaimed && s.tokens.some((t) => t.per <= now)) return done(NONE);
    if (s.notBefore !== null && now < s.notBefore) return done(wait(s.notBefore));
    return done(claim(true));
  }
  if (s.notBefore !== null && now < s.notBefore) return done(wait(s.notBefore));
  // (b): no token applied to this household yet. With no E header this is
  // also the only rule: one claim, then none while the token is held.
  if (s.appliedHousehold !== householdId) return done(s.tokens.length === 0 ? claim(false) : NONE);
  const e = s.entExp;
  if (e === null) return done(NONE);
  // A held token that moves E reaches the server at the next write.
  if (s.tokens.some((t) => t.exp > e)) return done(NONE);
  // (c) the renewal window.
  // A test household: when E is less than an hour away.
  if (s.testHousehold) return done(e - now < HOUR ? claim(false) : wait(e - HOUR + 1));
  const opens = e - 10 * DAY;
  const fast = e - 5 * DAY;
  if (s.windowFor !== e) {
    s.windowFor = e;
    s.windowAt = opens + random() * (fast - opens);
  }
  const at = Math.min(s.windowAt ?? fast, fast);
  return done(now >= at ? claim(false) : wait(at));
}

/** Folds a claim's answer into the state (§Claim errors). `current` is the
 * flag the claim was sent with. */
export function record(
  state: ClaimState,
  outcome: ClaimOutcome,
  current: boolean,
  now: number,
): ClaimState {
  const s = copy(state);
  switch (outcome.kind) {
    case "token": {
      const t = outcome.token;
      if (!s.tokens.some((h) => h.raw === t.raw)) s.tokens.push(t);
      s.stopped = false;
      s.lastRefusal = null;
      s.retryAfter = null;
      s.backoff = null;
      s.notBefore = null;
      s.lapseRefused = false;
      if (current) s.lapseClaimed = true;
      // A token that does not move E (a monthly renewal still ahead):
      // try again a day later.
      if (s.entExp !== null && t.exp <= s.entExp) s.notBefore = now + DAY;
      return s;
    }
    case "not-family":
      return forgetClaims(s);
    case "refused": {
      const r = outcome.reason;
      s.lastRefusal = r;
      s.backoff = null;
      if (STOPS.has(r)) {
        s.stopped = true;
      } else if (r === "replacement-used") {
        // Still bound elsewhere (next() checks lastRefusal); the date is
        // for the text.
        s.retryAfter = outcome.retryAfter;
      } else if (r === "bound-to-other-device") {
        // Refused while lapsed: at most once a day. Otherwise no retry at
        // all while E is in the future (next() checks lastRefusal).
        s.notBefore = current ? now + DAY : null;
        if (current) s.lapseRefused = true;
      } else {
        // payment-pending, inactive, revoked: at most once a day.
        s.notBefore = now + DAY;
      }
      return s;
    }
    case "unavailable": {
      const b = Math.min(Math.max((s.backoff ?? 0) * 2, FIRST_BACKOFF_MS), MAX_BACKOFF_MS);
      s.backoff = b;
      s.notBefore = now + b;
      return s;
    }
  }
}

/** A sync round's answer. `entExp` is the X-Sitr-Entitlement-Expires value
 * (null when absent), `lapsed` a `402 lapsed`, `succeeded` a 200/201 round,
 * `forced` the token sent by a forced write in this round. */
export interface SyncAnswer extends EndAnswer {
  forced: string | null;
}

/** Folds a sync round's answer into the state. A successful round without
 * the header is a version 1 household: no E, never lapsed. A failed round
 * without it changes nothing about E. */
export function observe(
  state: ClaimState,
  answer: SyncAnswer,
  householdId: string,
  now: number,
): ClaimState {
  const s = observeEnd(copy(state), answer, now);
  if (answer.succeeded && answer.forced !== null) s.forcedToken = answer.forced;
  const e = answer.entExp;
  if (e !== null) {
    const before = s.tokens.length;
    // "Delete it once a response shows E ≥ its exp."
    s.tokens = s.tokens.filter((t) => t.exp > e);
    if (s.tokens.length < before) s.appliedHousehold = householdId;
    if (e - now > LEGACY_DAYS * DAY) s.legacyEnd = e;
  }
  if (showsOpen(answer, s.entExp, now)) {
    s.lapseClaimed = false;
    s.lapseRefused = false;
  }
  // An unused token simply expires; the same claim gets it again.
  s.tokens = s.tokens.filter((t) => t.exp > now);
  return s;
}

/** The household was just created with `token` (201); `entExp` from the
 * answer's header, null when it had none. */
export function created(
  state: ClaimState,
  token: EntitlementToken,
  householdId: string,
  entExp: number | null,
): ClaimState {
  const s = copy(state);
  s.tokens = s.tokens.filter((t) => t.raw !== token.raw);
  s.appliedHousehold = householdId;
  s.testHousehold = token.test;
  s.entExp = entExp;
  s.lapsed = false;
  s.lapseClaimed = false;
  s.lapseRefused = false;
  return s;
}

/** The subscription code was entered, entered again or removed, or a token
 * of another plan came back: everything this device knew about its own
 * claims goes; what the sync server said about the household stays. */
export function forgetClaims(state: ClaimState): ClaimState {
  return {
    ...emptyClaimState(),
    testHousehold: state.testHousehold,
    entExp: state.entExp,
    lapsed: state.lapsed,
    legacyEnd: state.legacyEnd,
  };
}

/** The user asked (Try again): lift waits and stops. The memory of a
 * bound-to-other-device answer stays (§Claim errors). */
export function userRetry(state: ClaimState): ClaimState {
  return { ...copy(state), stopped: false, notBefore: null, backoff: null, lapseClaimed: false };
}

/** The token to send on the next PUT: the earliest period first, so an
 * early token goes at the following write. */
export function tokenToSend(s: ClaimState): EntitlementToken | null {
  let best: EntitlementToken | null = null;
  for (const t of s.tokens) if (best === null || t.per < best.per) best = t;
  return best;
}

/** Whether the next round writes even when nothing changed: once per token. */
export function forcesWrite(s: ClaimState): boolean {
  const t = tokenToSend(s);
  return t !== null && t.raw !== s.forcedToken;
}

/* ------------------------------ what to show ---------------------------- */

export type Notice =
  | "none"
  /** The default: waiting for renewal on the subscriber's device. */
  | "waiting"
  /** Only after a claim on THIS device came back inactive or revoked. */
  | "ended"
  /** After a claim on this device came back payment-pending. */
  | "payment-problem"
  /** After a rebind refused as replacement-used, until its retry_after
   * (the date is retryAfter). */
  | "replacement-used"
  /** A legacy household after the cut-over is announced, on a device that
   * holds no code; the date is E. */
  | "enter-code";

/** The Family screen's notice (§Sync 402; §A legacy household after the
 * cut-over is announced). Shown when lapsed, or while E is less than 2 days
 * away (not for test households, whose E is always under a day away). */
export function notice(s: ClaimState, now: number, holdsCode: boolean): Notice {
  const e = s.entExp;
  if (!holdsCode && e !== null && e > now && (e - now > LEGACY_DAYS * DAY || s.legacyEnd === e)) {
    return "enter-code";
  }
  if (endNotice(s, now) === "none") return "none";
  switch (s.lastRefusal) {
    case "inactive":
    case "revoked":
      return "ended";
    case "payment-pending":
      return "payment-problem";
    default:
      return s.retryAfter !== null && now < s.retryAfter ? "replacement-used" : "waiting";
  }
}

/** Offer "Renew on this device" (replace: true, plus current: true when
 * lapsed; ask first) in a household: another device holds the binding and
 * E is less than 2 days away; once E has passed, only after the claim
 * without replace was refused; never before a replacement-used answer's
 * retry_after. The creation flow offers it on any bound-to-other-device
 * answer. */
export function offersReplace(s: ClaimState, now: number): boolean {
  if (!boundElsewhere(s) || s.entExp === null) return false;
  if (s.retryAfter !== null && now < s.retryAfter) return false;
  if (isLapsed(s, now)) return s.lapseRefused;
  return s.entExp - now < 2 * DAY;
}

/* --------------------------------- texts -------------------------------- */

/** A `402 lapsed` shows the notice instead. */
export type TextCode =
  | Exclude<Notice, "none">
  | ClaimReason
  | Exclude<SyncRefusal, "lapsed">
  | "code-removed"
  | "input-invalid";

/** One English sentence per code. `{date}` is filled in by the caller (E for
 * enter-code and code-removed, retryAfter for replacement-used). Sentences
 * in quotes in the specification are used as written. */
export const TEXTS: Readonly<Record<TextCode, string>> = {
  waiting: WAITING_TEXT,
  ended: "Family has ended. Renew the subscription to sync changes again. Filtering continues.",
  "payment-problem": "Payment problem. Update the payment method to keep the household syncing. Filtering continues.",
  "enter-code": "Enter your subscription code on one guardian device before {date}.",
  "code-removed": "This device no longer renews the subscription. The household runs until {date}.",
  "input-invalid": "That is neither a subscription code nor a token.",
  "bound-to-other-device": "Another device renews this subscription.",
  "replacement-used": "The renewing device was moved recently. It can be moved again on {date}.",
  "payment-pending": "The payment is being retried. Update the payment method.",
  inactive: "The subscription is not active. Renew it to keep Sitr Family.",
  revoked: "The purchase was refunded or revoked.",
  "unknown-code": "No subscription has this code. Check it and enter it again.",
  "wrong-product": "This code is not for Sitr Family.",
  "invalid-receipt": "The subscription could not be confirmed (invalid-receipt).",
  "test-purchase": "The subscription could not be confirmed (test-purchase).",
  "family-sharing": "The subscription could not be confirmed (family-sharing).",
  "bad-request": "The subscription could not be confirmed (bad-request).",
  unrecognized: "The subscription could not be confirmed.",
  "token-required": "The subscription could not be confirmed (token-required).",
  "token-invalid": "The subscription could not be confirmed (token-invalid).",
  "token-expired": "The subscription could not be confirmed (token-expired).",
  "token-used": "The subscription could not be confirmed (token-used).",
  "plan-not-accepted": "This is a code for Sitr for Institutions.",
  "v1-ended": "Tokens are no longer accepted. Enter your subscription code.",
};
