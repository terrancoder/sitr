/**
 * Sync status — options-page visibility ONLY (CLAUDE.md §4).
 *
 * INVARIANT: sync state never touches `protectionStatus` or the badge.
 * Filtering is local; a broken sync leaves protection fully intact, so it
 * must not paint the toolbar red. It IS surfaced here, never swallowed.
 */

export const SYNC_STATUS_KEY = "syncStatus";

/** "not-found": a device that joined found no household for its code. */
export type SyncState = "never" | "ok" | "error" | "offline" | "not-found";

export interface SyncStatus {
  state: SyncState;
  lastSuccessAt?: number;
  error?: string;
}

export const NEVER_SYNCED: SyncStatus = { state: "never" };

export function sanitizeSyncStatus(raw: unknown): SyncStatus {
  if (typeof raw !== "object" || raw === null) return NEVER_SYNCED;
  const o = raw as Record<string, unknown>;
  const state = o["state"];
  if (
    state !== "never" &&
    state !== "ok" &&
    state !== "error" &&
    state !== "offline" &&
    state !== "not-found"
  ) {
    return NEVER_SYNCED;
  }
  return {
    state,
    ...(typeof o["lastSuccessAt"] === "number"
      ? { lastSuccessAt: o["lastSuccessAt"] }
      : {}),
    ...(typeof o["error"] === "string" ? { error: o["error"].slice(0, 500) } : {}),
  };
}

export const NO_HOUSEHOLD_FOR_CODE =
  "No household found for this code yet. Check the code with the person who " +
  "created the household. If the code is right, sync that device first; " +
  "otherwise leave and join again.";

export function describeSyncStatus(status: SyncStatus): string {
  switch (status.state) {
    case "never":
      return "Sync: not yet synced on this device.";
    case "ok":
      return status.lastSuccessAt !== undefined
        ? `Sync: up to date (last synced ${new Date(status.lastSuccessAt).toLocaleString()}).`
        : "Sync: up to date.";
    case "offline":
      return "Sync: offline — filtering still fully active on this device.";
    case "not-found":
      return NO_HOUSEHOLD_FOR_CODE;
    case "error":
      return `Sync: failed (${status.error ?? "unknown error"}) — filtering still fully active on this device.`;
  }
}
