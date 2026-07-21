/**
 * Household state — the settings a family shares across devices.
 * Pure, network-free logic (CLAUDE.md §9).
 *
 * The state is what gets E2E-encrypted into the sync blob
 * (docs/sync-protocol.md). The server never sees it in plaintext.
 *
 * Merge strategy: last-writer-wins on a monotonic `rev` counter. Only
 * guardian devices write, conflicts are rare, and a lost edit is trivially
 * re-enterable — vector clocks would be complexity without a customer
 * (CLAUDE.md §2). Documented in architecture.md.
 */
import { type Result, err, ok } from "./result.js";
import { sanitizeDisabled, type ToggleableRulesetId } from "./categories.js";
import { isValidDomain } from "./userRules.js";
import { sanitizePinRecord, type PinRecord } from "./pin.js";

export const HOUSEHOLD_STATE_KEY = "householdState";
export const HOUSEHOLD_ROLE_KEY = "householdRole";
export const HOUSEHOLD_SECRET_KEY = "householdSecret";
export const DEVICE_ID_KEY = "deviceId";

/** Hard cap keeps the encrypted blob far under the server's 64 KiB limit. */
export const MAX_HOUSEHOLD_DOMAINS = 2_000;

/**
 * Fair-use soft cap (threat-model: friction, never surveillance). No real
 * family hits 20 devices; a shared-with-the-neighborhood pairing code
 * does. Enforced by honest clients only — the server cannot count devices,
 * which is the product working as designed.
 */
export const MAX_HOUSEHOLD_DEVICES = 20;

export interface HouseholdState {
  v: 1;
  /** Monotonic write counter — the LWW clock. */
  rev: number;
  updatedAt: number;
  /** Random device id; meaningful only inside the household's own blob. */
  updatedBy: string;
  allowDomains: string[];
  blockDomains: string[];
  /** Random ids of enrolled devices — meaningful only inside the blob. */
  devices: string[];
  disabledCategories: ToggleableRulesetId[];
  /** Synced so the guardian PIN is household-wide. */
  pin?: PinRecord;
  policy: { childLockOptions: boolean };
}

export function emptyHouseholdState(deviceId: string, now: number): HouseholdState {
  return {
    v: 1,
    rev: 1,
    updatedAt: now,
    updatedBy: deviceId,
    allowDomains: [],
    blockDomains: [],
    devices: [deviceId],
    disabledCategories: [],
    policy: { childLockOptions: true },
  };
}

function sanitizeDomains(raw: unknown): Result<string[], string> {
  if (!Array.isArray(raw)) return ok([]);
  const domains = [
    ...new Set(raw.filter((d): d is string => typeof d === "string" && isValidDomain(d))),
  ].sort();
  if (domains.length > MAX_HOUSEHOLD_DOMAINS) {
    return err(`household list exceeds ${MAX_HOUSEHOLD_DOMAINS} domains`);
  }
  return ok(domains);
}

/**
 * Total validator for anything claiming to be a HouseholdState — used on
 * every decrypted blob and every storage read. Unknown schema versions are
 * an ERROR, not a guess: the caller keeps its last-known-good state and
 * surfaces the problem in sync status (never bricks filtering).
 */
export function sanitizeHouseholdState(raw: unknown): Result<HouseholdState, string> {
  if (typeof raw !== "object" || raw === null) {
    return err("household state is not an object");
  }
  const o = raw as Record<string, unknown>;
  if (o["v"] !== 1) return err(`unknown household state version: ${String(o["v"])}`);
  if (typeof o["rev"] !== "number" || !Number.isInteger(o["rev"]) || o["rev"] < 1) {
    return err("household state has no valid rev");
  }
  const allow = sanitizeDomains(o["allowDomains"]);
  if (!allow.ok) return allow;
  const block = sanitizeDomains(o["blockDomains"]);
  if (!block.ok) return block;
  const devices = Array.isArray(o["devices"])
    ? [
        ...new Set(
          o["devices"].filter(
            (d): d is string =>
              typeof d === "string" && d.length > 0 && d.length <= 64,
          ),
        ),
      ].sort()
    : [];
  if (devices.length > MAX_HOUSEHOLD_DEVICES) {
    return err(
      `household has more than ${MAX_HOUSEHOLD_DEVICES} devices — see the fair-use policy`,
    );
  }
  const policyRaw =
    typeof o["policy"] === "object" && o["policy"] !== null
      ? (o["policy"] as Record<string, unknown>)
      : {};
  const pin = sanitizePinRecord(o["pin"]);
  return ok({
    v: 1,
    rev: o["rev"],
    updatedAt:
      typeof o["updatedAt"] === "number" && o["updatedAt"] >= 0 ? o["updatedAt"] : 0,
    updatedBy: typeof o["updatedBy"] === "string" ? o["updatedBy"].slice(0, 64) : "",
    allowDomains: allow.value,
    blockDomains: block.value,
    devices,
    disabledCategories: sanitizeDisabled(o["disabledCategories"]),
    ...(pin !== undefined ? { pin } : {}),
    policy: { childLockOptions: policyRaw["childLockOptions"] !== false },
  });
}

/** Last-writer-wins; ties broken by updatedAt, then updatedBy (stable). */
export function mergeStates(a: HouseholdState, b: HouseholdState): HouseholdState {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy > b.updatedBy ? a : b;
}

/** A new revision authored by this device. */
export function bumpRev(
  s: HouseholdState,
  deviceId: string,
  now: number,
): HouseholdState {
  return { ...s, rev: s.rev + 1, updatedAt: now, updatedBy: deviceId };
}
