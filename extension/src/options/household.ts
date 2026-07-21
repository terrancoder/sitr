/**
 * Household UI glue for the options page: create/join/leave a household,
 * guardian PIN ceremony, and the shared allow/block lists.
 *
 * All persistence is storage.local; all filtering changes go through the
 * engine first (applyHouseholdState). Sync (if the household chooses it)
 * runs in the background worker — this page only edits state and bumps rev.
 */
import {
  DEVICE_ID_KEY,
  HOUSEHOLD_ROLE_KEY,
  HOUSEHOLD_SECRET_KEY,
  HOUSEHOLD_STATE_KEY,
  bumpRev,
  emptyHouseholdState,
  sanitizeHouseholdState,
  type HouseholdState,
} from "../lib/household.js";
import {
  decodePairingCode,
  encodePairingCode,
  generateRootSecret,
} from "../lib/sync/crypto.js";
import { applyHouseholdState } from "../lib/sync/apply.js";
import {
  NO_ATTEMPTS,
  PIN_ATTEMPTS_KEY,
  PIN_KEY,
  backoffAfterFailure,
  createPinRecord,
  isLockedOut,
  sanitizeAttempts,
  sanitizePinRecord,
  verifyPin,
  fromB64,
  toB64,
} from "../lib/pin.js";
import { gateMutation, type HouseholdRole, type MutationKind } from "../lib/gate.js";
import type { ManagedPolicy } from "../lib/managed.js";
import { normalizeDomainInput } from "../lib/userRules.js";

export interface HouseholdContext {
  role: HouseholdRole | undefined;
  state: HouseholdState | undefined;
  managed: ManagedPolicy;
  showError(message: string): void;
  onChanged(): Promise<void>;
}

const engineDeps = {
  getDynamicRules: () => chrome.declarativeNetRequest.getDynamicRules(),
  updateDynamicRules: (u: { addRules?: unknown[]; removeRuleIds?: number[] }) =>
    chrome.declarativeNetRequest.updateDynamicRules(
      u as chrome.declarativeNetRequest.UpdateRuleOptions,
    ),
  updateEnabledRulesets: (u: {
    enableRulesetIds?: string[];
    disableRulesetIds?: string[];
  }) => chrome.declarativeNetRequest.updateEnabledRulesets(u),
  persist: async (state: HouseholdState) => {
    await chrome.storage.local.set({ [HOUSEHOLD_STATE_KEY]: state });
  },
};

export async function loadHousehold(): Promise<{
  role: HouseholdRole | undefined;
  state: HouseholdState | undefined;
}> {
  const stored = await chrome.storage.local.get([
    HOUSEHOLD_ROLE_KEY,
    HOUSEHOLD_STATE_KEY,
  ]);
  const roleRaw = stored[HOUSEHOLD_ROLE_KEY];
  const role: HouseholdRole | undefined =
    roleRaw === "guardian" || roleRaw === "child" ? roleRaw : undefined;
  const stateRes = sanitizeHouseholdState(stored[HOUSEHOLD_STATE_KEY]);
  return { role, state: stateRes.ok ? stateRes.value : undefined };
}

async function deviceId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (typeof stored[DEVICE_ID_KEY] === "string" && stored[DEVICE_ID_KEY]) {
    return stored[DEVICE_ID_KEY] as string;
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
  return id;
}

/* ------------------------------ PIN ceremony --------------------------- */

async function loadPinState() {
  const stored = await chrome.storage.local.get([PIN_KEY, PIN_ATTEMPTS_KEY]);
  return {
    record: sanitizePinRecord(stored[PIN_KEY]),
    attempts: sanitizeAttempts(stored[PIN_ATTEMPTS_KEY]),
  };
}

/**
 * Run `action` behind the mutation gate. Prompts for the PIN when the gate
 * requires it; persists failed-attempt state BEFORE reporting failure.
 * Returns false when the action was refused.
 */
export async function withGate(
  kind: MutationKind,
  ctx: HouseholdContext,
  action: () => Promise<void>,
): Promise<boolean> {
  const { record, attempts } = await loadPinState();
  const verdict = gateMutation(kind, {
    managed: ctx.managed,
    role: ctx.role,
    hasPin: record !== undefined,
  });
  if (!verdict.allowed) {
    ctx.showError(
      verdict.reason === "managed-locked"
        ? "Settings are locked by your organization's administrator."
        : "This setting can only be changed from a guardian device.",
    );
    return false;
  }
  if (verdict.requiresPin && record !== undefined) {
    const lock = isLockedOut(attempts, Date.now());
    if (!lock.ok) {
      const seconds = Math.ceil((lock.error.retryAt - Date.now()) / 1000);
      ctx.showError(`Too many wrong PIN attempts — try again in ${seconds}s.`);
      return false;
    }
    const entered = window.prompt("Enter the guardian PIN:");
    if (entered === null) return false;
    if (!(await verifyPin(entered, record))) {
      const next = backoffAfterFailure(attempts.count, Date.now());
      await chrome.storage.local.set({ [PIN_ATTEMPTS_KEY]: next });
      ctx.showError("Wrong PIN.");
      return false;
    }
    await chrome.storage.local.set({ [PIN_ATTEMPTS_KEY]: NO_ATTEMPTS });
  }
  await action();
  return true;
}

/* --------------------------- household actions -------------------------- */

async function saveMutatedState(
  ctx: HouseholdContext,
  mutate: (s: HouseholdState) => HouseholdState,
): Promise<void> {
  if (ctx.state === undefined) return;
  const next = bumpRev(mutate(ctx.state), await deviceId(), Date.now());
  const applied = await applyHouseholdState(
    next,
    ctx.managed.forcedCategories,
    engineDeps,
  );
  if (!applied.ok) {
    ctx.showError(`Could not apply household rules: ${applied.error}`);
    return;
  }
  ctx.state = next;
}

export async function createHousehold(ctx: HouseholdContext): Promise<void> {
  const secret = generateRootSecret();
  const state = emptyHouseholdState(await deviceId(), Date.now());
  const applied = await applyHouseholdState(
    state,
    ctx.managed.forcedCategories,
    engineDeps,
  );
  if (!applied.ok) {
    ctx.showError(`Could not create household: ${applied.error}`);
    return;
  }
  await chrome.storage.local.set({
    [HOUSEHOLD_SECRET_KEY]: toB64(secret),
    [HOUSEHOLD_ROLE_KEY]: "guardian",
  });
  ctx.role = "guardian";
  ctx.state = state;
}

export async function joinHousehold(
  ctx: HouseholdContext,
  code: string,
  role: HouseholdRole,
): Promise<void> {
  const secret = decodePairingCode(code);
  if (!secret.ok) {
    ctx.showError(secret.error);
    return;
  }
  // Until the first sync pull, start from the empty shared state authored
  // at epoch 0 — so the REAL household state always wins the LWW merge on
  // the first pull, whatever its rev or timestamp.
  const state = emptyHouseholdState(await deviceId(), 0);
  const applied = await applyHouseholdState(
    state,
    ctx.managed.forcedCategories,
    engineDeps,
  );
  if (!applied.ok) {
    ctx.showError(`Could not join household: ${applied.error}`);
    return;
  }
  await chrome.storage.local.set({
    [HOUSEHOLD_SECRET_KEY]: toB64(secret.value),
    [HOUSEHOLD_ROLE_KEY]: role,
  });
  ctx.role = role;
  ctx.state = state;
}

export async function leaveHousehold(ctx: HouseholdContext): Promise<void> {
  // Remove the household rule layer from the engine, then forget the keys.
  const cleared = { ...emptyHouseholdState(await deviceId(), Date.now()) };
  cleared.allowDomains = [];
  cleared.blockDomains = [];
  const applied = await applyHouseholdState(
    cleared,
    ctx.managed.forcedCategories,
    engineDeps,
  );
  if (!applied.ok) {
    ctx.showError(`Could not remove household rules: ${applied.error}`);
    return;
  }
  await chrome.storage.local.remove([
    HOUSEHOLD_SECRET_KEY,
    HOUSEHOLD_ROLE_KEY,
    HOUSEHOLD_STATE_KEY,
  ]);
  ctx.role = undefined;
  ctx.state = undefined;
}

export async function showPairingCode(ctx: HouseholdContext): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(HOUSEHOLD_SECRET_KEY);
  if (typeof stored[HOUSEHOLD_SECRET_KEY] !== "string") {
    ctx.showError("No household on this device.");
    return undefined;
  }
  const secret = fromB64(stored[HOUSEHOLD_SECRET_KEY] as string);
  if (!secret.ok) {
    ctx.showError("Stored household secret is corrupted — re-create the household.");
    return undefined;
  }
  return encodePairingCode(secret.value);
}

export async function addHouseholdDomain(
  ctx: HouseholdContext,
  kind: "allow" | "block",
  rawInput: string,
): Promise<void> {
  const domain = normalizeDomainInput(rawInput);
  if (!domain.ok) {
    ctx.showError(domain.error);
    return;
  }
  await saveMutatedState(ctx, (s) => ({
    ...s,
    [kind === "allow" ? "allowDomains" : "blockDomains"]: [
      ...new Set([
        ...(kind === "allow" ? s.allowDomains : s.blockDomains),
        domain.value,
      ]),
    ].sort(),
  }));
}

export async function removeHouseholdDomain(
  ctx: HouseholdContext,
  kind: "allow" | "block",
  domain: string,
): Promise<void> {
  await saveMutatedState(ctx, (s) => ({
    ...s,
    [kind === "allow" ? "allowDomains" : "blockDomains"]: (kind === "allow"
      ? s.allowDomains
      : s.blockDomains
    ).filter((d) => d !== domain),
  }));
}

export async function setGuardianPin(
  ctx: HouseholdContext,
  pin: string,
): Promise<void> {
  const record = await createPinRecord(pin);
  if (!record.ok) {
    ctx.showError(record.error);
    return;
  }
  await chrome.storage.local.set({
    [PIN_KEY]: record.value,
    [PIN_ATTEMPTS_KEY]: NO_ATTEMPTS,
  });
  // Sync the PIN household-wide when a household exists.
  await saveMutatedState(ctx, (s) => ({ ...s, pin: record.value }));
}

export async function hasGuardianPin(): Promise<boolean> {
  const { record } = await loadPinState();
  return record !== undefined;
}
