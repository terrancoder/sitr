/**
 * Sitr background service worker.
 *
 * Responsibilities (and nothing else — CLAUDE.md §7, single purpose):
 *  - verify the bundled DNR rulesets are actually enabled
 *  - apply managed (enterprise) policy and re-verify after changes
 *  - surface "Protection inactive" visibly (badge + stored status) when not
 *  - run the optional Family household sync (lib/sync) when one is configured
 *
 * Apart from that sync — one end-to-end-encrypted settings blob exchanged
 * with sync.sitr.app, and only after the user creates or joins a household —
 * this worker makes no network requests. Filtering is done entirely by the
 * browser's DNR engine. Managed policy arrives through the browser's own
 * chrome.storage.managed channel (GPO / plist / Google Admin), never over
 * the network from us.
 */
import { badgeFor, deriveStatus, type ProtectionStatus } from "../lib/status.js";
import {
  DISABLED_CATEGORIES_KEY,
  sanitizeDisabled,
  type ToggleableRulesetId,
} from "../lib/categories.js";
import {
  EMPTY_MANAGED_POLICY,
  effectiveRequiredRulesets,
  isManaged,
  sanitizeManagedPolicy,
  type ManagedPolicy,
} from "../lib/managed.js";
import { planLayerUpdate, type RuleKind } from "../lib/ruleLayers.js";
import {
  DEVICE_ID_KEY,
  HOUSEHOLD_SECRET_KEY,
  HOUSEHOLD_STATE_KEY,
  MAX_HOUSEHOLD_DEVICES,
  bumpRev,
  sanitizeHouseholdState,
} from "../lib/household.js";
import { fromB64 } from "../lib/pin.js";
import { MAX_SEEN_REV_KEY, syncOnce } from "../lib/sync/client.js";
import { applyHouseholdState } from "../lib/sync/apply.js";
import { SYNC_STATUS_KEY } from "../lib/sync/status.js";

/**
 * Read managed policy. An absent or unreadable managed store is the empty
 * policy: consumer profiles must behave exactly as before this feature
 * existed. (A managed device whose policy fails to APPLY is a different,
 * loud case — see applyManagedPolicy.)
 */
async function readManagedPolicy(): Promise<ManagedPolicy> {
  try {
    const raw = await chrome.storage.managed.get(null);
    return sanitizeManagedPolicy(raw);
  } catch {
    return EMPTY_MANAGED_POLICY;
  }
}

async function readDeviceDisabled(): Promise<ToggleableRulesetId[]> {
  const stored = await chrome.storage.local.get(DISABLED_CATEGORIES_KEY);
  return sanitizeDisabled(stored[DISABLED_CATEGORIES_KEY]);
}

/**
 * Reconcile the managed dynamic-rule layer with policy, and re-enable any
 * forced categories. Returns an error string on failure so the caller can
 * surface it as a protection failure (§4: fail visible) — a managed device
 * whose policy cannot be applied is NOT protected as the admin intends.
 */
async function applyManagedPolicy(policy: ManagedPolicy): Promise<string | null> {
  try {
    const live = await chrome.declarativeNetRequest.getDynamicRules();
    for (const [kind, desired] of [
      ["block", policy.managedBlockDomains],
      ["allow", policy.managedAllowDomains],
    ] as Array<[RuleKind, string[]]>) {
      const plan = planLayerUpdate(live, "managed", kind, desired);
      if (!plan.ok) return plan.error;
      if (plan.value.addRules.length > 0 || plan.value.removeRuleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: plan.value.addRules as chrome.declarativeNetRequest.Rule[],
          removeRuleIds: plan.value.removeRuleIds,
        });
      }
    }
    if (policy.forcedCategories.length > 0) {
      // Engine first (§4): force the rulesets on regardless of local prefs.
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: policy.forcedCategories,
      });
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function checkProtection(): Promise<ProtectionStatus> {
  try {
    const policy = await readManagedPolicy();
    if (isManaged(policy)) {
      const applyError = await applyManagedPolicy(policy);
      if (applyError !== null) {
        return {
          state: "unknown",
          reason: `managed policy not applied: ${applyError}`,
        };
      }
    }
    const required = effectiveRequiredRulesets(
      await readDeviceDisabled(),
      [], // household categories layer in when a household exists (sync step)
      policy.forcedCategories,
    );
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    return deriveStatus(enabled, required);
  } catch (e) {
    // Fail visible, fail safe: an error querying rulesets means we cannot
    // prove protection — report unknown, which renders as a red badge.
    return {
      state: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function renderStatus(status: ProtectionStatus): Promise<void> {
  const badge = badgeFor(status);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setTitle({ title: badge.title });
  // Stored locally only, for the popup to read. Never transmitted.
  await chrome.storage.local.set({ protectionStatus: status });
}

async function refresh(): Promise<void> {
  const status = await checkProtection();
  if (status.state !== "active") {
    // Developer-facing log: state only — no URLs, no identifiers (§4).
    console.error("[sitr] protection not active:", status);
  }
  await renderStatus(status);
}

/* ------------------------------ family sync ----------------------------- */

const SYNC_ALARM = "sitr-sync";
let syncInFlight = false;

/**
 * One sync round. Failures write ONLY the sync status (options page); they
 * never touch protectionStatus or the badge — filtering is local and fully
 * intact when the server is unreachable (CLAUDE.md §4 + data-flow.md).
 */
async function runSync(): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const stored = await chrome.storage.local.get([
      HOUSEHOLD_SECRET_KEY,
      HOUSEHOLD_STATE_KEY,
      MAX_SEEN_REV_KEY,
      DEVICE_ID_KEY,
      "entitlementToken",
    ]);
    if (typeof stored[HOUSEHOLD_SECRET_KEY] !== "string") return; // no household
    const secret = fromB64(stored[HOUSEHOLD_SECRET_KEY] as string);
    const local = sanitizeHouseholdState(stored[HOUSEHOLD_STATE_KEY]);
    if (!secret.ok || !local.ok) {
      await chrome.storage.local.set({
        [SYNC_STATUS_KEY]: {
          state: "error",
          error: !secret.ok
            ? "stored household secret is corrupted"
            : !local.ok
              ? local.error
              : "unreachable",
        },
      });
      return;
    }
    const outcome = await syncOnce(
      {
        rootSecret: secret.value,
        local: local.value,
        maxSeenRev:
          typeof stored[MAX_SEEN_REV_KEY] === "number"
            ? (stored[MAX_SEEN_REV_KEY] as number)
            : 0,
        deviceId:
          typeof stored[DEVICE_ID_KEY] === "string"
            ? (stored[DEVICE_ID_KEY] as string)
            : "unknown-device",
        entitlement:
          typeof stored["entitlementToken"] === "string"
            ? (stored["entitlementToken"] as string)
            : undefined,
      },
      { fetch: fetch.bind(globalThis), now: () => Date.now() },
    );
    if (outcome.status.state === "ok" && outcome.state !== local.value) {
      const policy = await readManagedPolicy();
      const applied = await applyHouseholdState(
        outcome.state,
        policy.forcedCategories,
        {
          getDynamicRules: () => chrome.declarativeNetRequest.getDynamicRules(),
          updateDynamicRules: (u) =>
            chrome.declarativeNetRequest.updateDynamicRules(
              u as chrome.declarativeNetRequest.UpdateRuleOptions,
            ),
          updateEnabledRulesets: (u) =>
            chrome.declarativeNetRequest.updateEnabledRulesets(u),
          persist: async (state) => {
            await chrome.storage.local.set({ [HOUSEHOLD_STATE_KEY]: state });
          },
        },
      );
      if (!applied.ok) {
        await chrome.storage.local.set({
          [SYNC_STATUS_KEY]: { state: "error", error: applied.error },
        });
        return;
      }
    }
    await chrome.storage.local.set({
      [SYNC_STATUS_KEY]: outcome.status,
      [MAX_SEEN_REV_KEY]: outcome.maxSeenRev,
    });
    // Fair-use soft cap: register this device in the household state after
    // a successful sync. At the cap, refuse — surfaced in sync status, but
    // filtering stays fully active (friction, never a protection failure).
    if (outcome.status.state === "ok") {
      const deviceId =
        typeof stored[DEVICE_ID_KEY] === "string"
          ? (stored[DEVICE_ID_KEY] as string)
          : "unknown-device";
      if (!outcome.state.devices.includes(deviceId)) {
        if (outcome.state.devices.length >= MAX_HOUSEHOLD_DEVICES) {
          await chrome.storage.local.set({
            [SYNC_STATUS_KEY]: {
              state: "error",
              error: `household already has ${MAX_HOUSEHOLD_DEVICES} devices (fair-use limit) — remove one from a guardian device first`,
            },
          });
          return;
        }
        const registered = bumpRev(
          {
            ...outcome.state,
            devices: [...outcome.state.devices, deviceId].sort(),
          },
          deviceId,
          Date.now(),
        );
        // Persisting triggers storage.onChanged → the next sync pushes it.
        await chrome.storage.local.set({ [HOUSEHOLD_STATE_KEY]: registered });
      }
    }
  } finally {
    syncInFlight = false;
  }
}

async function ensureSyncAlarm(): Promise<void> {
  const stored = await chrome.storage.local.get(HOUSEHOLD_SECRET_KEY);
  if (typeof stored[HOUSEHOLD_SECRET_KEY] === "string") {
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 30 });
    void runSync();
  } else {
    await chrome.alarms.clear(SYNC_ALARM);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void runSync();
});

chrome.runtime.onInstalled.addListener(() => {
  void refresh();
  void ensureSyncAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  void refresh();
  void ensureSyncAlarm();
});
// Re-check whenever settings change: the options page toggles categories
// (local) and admins can push or update policy at runtime (managed).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" || area === "managed") void refresh();
  if (area === "local" && HOUSEHOLD_STATE_KEY in changes) void runSync();
  if (area === "local" && HOUSEHOLD_SECRET_KEY in changes) void ensureSyncAlarm();
});
void refresh();
void ensureSyncAlarm();
