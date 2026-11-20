/**
 * The end date of a Sitr Family household, as every member device sees it
 * (docs/sync-protocol.md §Sync-server rules, §Sync 402). Pure: no fetch, no
 * chrome.*, no storage.
 *
 * This is all a device that only belongs to a household needs: the sync
 * server's end date `E`, whether the household is read-only, and the
 * neutral notice. The renewing device's logic is in entitlement.ts, which
 * builds on this module; this module never imports it. The Safari App
 * Store staging ships this module and leaves entitlement.ts out, so its
 * code, comments and texts stay free of the words that staging refuses
 * (tools/pack/stage-safari.mjs).
 */

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** What a member device remembers about its household's end. */
export interface HouseholdEnd {
  /** `E`, from X-Sitr-Entitlement-Expires; null: no such header (a
   * version 1 household, never read-only). */
  entExp: number | null;
  /** A `402 lapsed` was seen and no successful round has shown E > now since. */
  lapsed: boolean;
  /** The household was created by a `test: true` token. */
  testHousehold: boolean;
}

/** X-Sitr-Entitlement-Expires: decimal epoch ms (surrounding blanks
 * allowed, at most 16 digits), else null. */
export function parseEndHeader(value: string | null): number | null {
  if (value === null) return null;
  const v = value.trim();
  return /^[0-9]{1,16}$/.test(v) ? Number(v) : null;
}

/** A sync round's answer: `entExp` the header (null when absent), `lapsed`
 * a `402 lapsed`, `succeeded` a 200/201 round. */
export interface EndAnswer {
  entExp: number | null;
  lapsed: boolean;
  succeeded: boolean;
}

/** Whether this answer shows the household open: a successful round,
 * not a `402 lapsed`, with E (after the answer) absent or in the future. */
export function showsOpen(answer: EndAnswer, entExpAfter: number | null, now: number): boolean {
  return !answer.lapsed && answer.succeeded && (entExpAfter === null || entExpAfter > now);
}

/** Folds a sync round's answer in. A successful round without the header
 * is a version 1 household: no E, never read-only. A failed round without
 * it changes nothing about E. */
export function observeEnd<T extends HouseholdEnd>(state: T, answer: EndAnswer, now: number): T {
  const s = { ...state };
  if (answer.entExp !== null) s.entExp = answer.entExp;
  else if (answer.succeeded) s.entExp = null;
  if (answer.lapsed) s.lapsed = true;
  else if (showsOpen(answer, s.entExp, now)) s.lapsed = false;
  return s;
}

/** Read-only: E has passed, or the server answered `402 lapsed`. */
export function isLapsed(s: { entExp: number | null; lapsed: boolean }, now: number): boolean {
  return s.lapsed || (s.entExp !== null && s.entExp <= now);
}

/** The neutral notice: when read-only, or while E is less than 2 days away
 * (not for test households, whose E is always under a day away). */
export function endNotice(s: HouseholdEnd, now: number): "none" | "waiting" {
  const soon = !s.testHousehold && s.entExp !== null && s.entExp - now < 2 * DAY;
  return isLapsed(s, now) || soon ? "waiting" : "none";
}

export type SyncRefusal =
  | "lapsed"
  | "token-required"
  | "token-invalid"
  | "token-expired"
  | "plan-not-accepted"
  | "token-used"
  | "v1-ended";

const SYNC_REFUSALS: readonly SyncRefusal[] = [
  "lapsed",
  "token-required",
  "token-invalid",
  "token-expired",
  "plan-not-accepted",
  "token-used",
  "v1-ended",
];

/** The version 1 server's 402 bodies (server-hotfix-live), read as reasons. */
const V1_BODIES: Readonly<Record<string, SyncRefusal>> = {
  "entitlement required": "token-required",
  "malformed entitlement token": "token-invalid",
  "invalid entitlement signature": "token-invalid",
  "malformed entitlement payload": "token-invalid",
  "unsupported entitlement version": "token-invalid",
  "entitlement expired — please renew": "token-expired",
};

/** A sync server 402's reason: the first line of the body, trimmed. Null
 * for any other status or an unknown first line. */
export function parseSyncRefusal(status: number, body: string): SyncRefusal | null {
  if (status !== 402) return null;
  const first = (body.split("\n")[0] ?? "").trim();
  if ((SYNC_REFUSALS as readonly string[]).includes(first)) return first as SyncRefusal;
  return V1_BODIES[first] ?? null;
}

/** The neutral sentence for "waiting" and for a `402 lapsed`. */
export const WAITING_TEXT =
  "Waiting for renewal on the guardian device that renews the Family plan. Filtering continues; changes will sync after renewal.";
