/**
 * "Wait before loosening" — an optional, device-local delay in front of
 * every loosening change. Pure: no chrome.*, no clock reads. The platform
 * supplies `now` (ms) and persists whatever `evaluate` hands back.
 *
 * Ported to Kotlin and Swift; apps/shared/fixtures/delay.json pins all
 * three. The one rule: a misbehaving clock may open the window LATE, never
 * EARLY.
 */
import {
  LOOSENING,
  gateMutation,
  type GateContext,
  type MutationKind,
} from "./gate.js";

/** Allowed delays in minutes; 0 = off. */
export const DELAY_MINUTES = [0, 5, 30, 60, 360, 1440] as const;
/** How long changes stay open once the wait has run out. */
export const WINDOW_MS = 10 * 60_000;

export type DelayPhase = "off" | "idle" | "waiting" | "open";
export interface DelayRequest {
  at: number;
}
export interface DelayEvaluation {
  phase: DelayPhase;
  remainingMs: number;
  /** The request to persist: may be restarted (clock went back) or cleared. */
  request: DelayRequest | null;
}

/**
 * The delay's own actions. Making the delay shorter (or off) is a
 * loosening; making it longer (or turning it on) is not an action at all.
 * Joining a household is a loosening too: the household's settings arrive
 * by sync and replace this device's own.
 */
export type DelayAction = MutationKind | "shortenDelay" | "joinHousehold";

/** storage.local keys — device-local, never in the household blob. */
export const DELAY_MINUTES_KEY = "loosenDelayMinutes";
export const DELAY_REQUEST_KEY = "loosenDelayRequest";

export function sanitizeDelayMinutes(raw: unknown): number {
  return (DELAY_MINUTES as readonly unknown[]).includes(raw) ? (raw as number) : 0;
}

export function sanitizeDelayRequest(raw: unknown): DelayRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const at = (raw as Record<string, unknown>)["at"];
  return typeof at === "number" && Number.isSafeInteger(at) && at >= 0
    ? { at }
    : null;
}

export function evaluate(
  delayMinutes: number,
  request: DelayRequest | null,
  now: number,
): DelayEvaluation {
  if (delayMinutes <= 0) return { phase: "off", remainingMs: 0, request: null };
  if (request === null) return { phase: "idle", remainingMs: 0, request: null };
  const delayMs = delayMinutes * 60_000;
  // Clock went backwards (reboot on a monotonic clock, wall clock set
  // back): restart the wait from now rather than guess.
  if (now < request.at) {
    return { phase: "waiting", remainingMs: delayMs, request: { at: now } };
  }
  // Via elapsed, never `at + delay`: no overflow near the top of the range.
  const elapsed = now - request.at;
  if (elapsed < delayMs) {
    return { phase: "waiting", remainingMs: delayMs - elapsed, request };
  }
  if (elapsed - delayMs < WINDOW_MS) {
    return { phase: "open", remainingMs: WINDOW_MS - (elapsed - delayMs), request };
  }
  return { phase: "idle", remainingMs: 0, request: null };
}

/** True when `action` must wait for the open window before it may run. */
export function needsWait(action: DelayAction, phase: DelayPhase): boolean {
  if (phase === "off" || phase === "open") return false;
  if (action === "joinHousehold") return needsWait(JOIN_HOUSEHOLD_WAITS_AS, phase);
  return action === "shortenDelay" || LOOSENING.has(action);
}

/** Changing the setting: "shortenDelay" when shorter or off, else free (null). */
export function delayChangeAction(
  fromMinutes: number,
  toMinutes: number,
): "shortenDelay" | null {
  return toMinutes < fromMinutes ? "shortenDelay" : null;
}

/**
 * The gate has no row for the delay (gate.json stays as it is), so
 * shortening the delay is gated exactly like disabling a category: refused
 * on a managed lock or a child device, PIN when one is set.
 */
export const SHORTEN_DELAY_GATED_AS: MutationKind = "disableCategory";

/**
 * Joining a household waits exactly like disabling a category
 * (delay.json "joinHouseholdWaitsAs"). It is never refused: joining was
 * never subject to the managed lock or the child role (there is no
 * household yet), and a first-time setup with no wait and no PIN joins
 * straight away. When this device has its own PIN, joining asks for it.
 */
export const JOIN_HOUSEHOLD_WAITS_AS: MutationKind = "disableCategory";

export type MutationStep =
  | { step: "refused"; reason: "managed-locked" | "child-device" }
  | { step: "wait" }
  | { step: "pin" }
  | { step: "go" };

/** The whole order in one place: gate first, then the delay, then the PIN. */
export function decideMutation(
  action: DelayAction,
  ctx: GateContext,
  phase: DelayPhase,
): MutationStep {
  if (action === "joinHousehold") {
    if (needsWait(action, phase)) return { step: "wait" };
    return ctx.hasPin ? { step: "pin" } : { step: "go" };
  }
  const verdict = gateMutation(
    action === "shortenDelay" ? SHORTEN_DELAY_GATED_AS : action,
    ctx,
  );
  if (!verdict.allowed) return { step: "refused", reason: verdict.reason };
  if (needsWait(action, phase)) return { step: "wait" };
  return verdict.requiresPin ? { step: "pin" } : { step: "go" };
}
