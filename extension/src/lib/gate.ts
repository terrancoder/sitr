/**
 * Mutation gate — the entire "who may change what, and with what
 * ceremony" policy as one pure, exhaustively testable table (CLAUDE.md §9).
 *
 * Layers of authority, strongest first:
 *   managed lockOptions  → nothing may change on this device
 *   child role           → household-level settings are read-only
 *   guardian PIN         → sensitive loosening actions require the PIN
 */
import type { ManagedPolicy } from "./managed.js";

export type HouseholdRole = "guardian" | "child";

export type MutationKind =
  /** Loosening actions — these are what the PIN protects. */
  | "disableCategory"
  | "removeDeviceBlockRule"
  | "addDeviceAllowRule"
  | "removeHouseholdRule"
  | "leaveHousehold"
  /** Tightening or neutral actions — never PIN-gated. */
  | "enableCategory"
  | "addDeviceBlockRule"
  | "removeDeviceAllowRule"
  | "addHouseholdRule"
  | "changePin";

export interface GateContext {
  managed: ManagedPolicy;
  role: HouseholdRole | undefined;
  hasPin: boolean;
}

export type MutationVerdict =
  | { allowed: true; requiresPin: boolean }
  | { allowed: false; reason: "managed-locked" | "child-device" };

const HOUSEHOLD_ONLY: ReadonlySet<MutationKind> = new Set([
  "removeHouseholdRule",
  "addHouseholdRule",
  "leaveHousehold",
  "changePin",
]);

const LOOSENING: ReadonlySet<MutationKind> = new Set([
  "disableCategory",
  "removeDeviceBlockRule",
  "addDeviceAllowRule",
  "removeHouseholdRule",
  "leaveHousehold",
]);

export function gateMutation(
  kind: MutationKind,
  ctx: GateContext,
): MutationVerdict {
  if (ctx.managed.lockOptions) {
    return { allowed: false, reason: "managed-locked" };
  }
  if (ctx.role === "child") {
    // A child device may still tighten its own device rules; everything
    // household-level or loosening is guardian territory.
    if (HOUSEHOLD_ONLY.has(kind) || LOOSENING.has(kind)) {
      return { allowed: false, reason: "child-device" };
    }
    return { allowed: true, requiresPin: false };
  }
  // Guardian (or no household at all): loosening actions need the PIN
  // when one is set. changePin always requires the current PIN if set.
  const requiresPin =
    ctx.hasPin && (LOOSENING.has(kind) || kind === "changePin");
  return { allowed: true, requiresPin };
}
