/**
 * Household UI glue for the options page: create/join/leave a household,
 * guardian PIN ceremony, and the shared allow/block lists.
 *
 * All persistence is storage.local; all filtering changes go through the
 * engine first (applyHouseholdState). Sync (if the household chooses it)
 * runs in the background worker — this page only edits state and bumps rev,
 * except leaving, which takes this device off the household's device list.
 */
import {
  DEVICE_ID_KEY,
  HOUSEHOLD_ROLE_KEY,
  HOUSEHOLD_SECRET_KEY,
  HOUSEHOLD_STATE_KEY,
  bumpRev,
  emptyHouseholdState,
  isJoinPlaceholder,
  sanitizeHouseholdState,
  type HouseholdState,
} from "../lib/household.js";
import {
  decodePairingCode,
  encodePairingCode,
  generateRootSecret,
} from "../lib/sync/crypto.js";
import { applyHouseholdState } from "../lib/sync/apply.js";
import { MAX_SEEN_REV_KEY, unenroll, type SyncDeps } from "../lib/sync/client.js";
import { DISABLED_CATEGORIES_KEY, sanitizeDisabled } from "../lib/categories.js";
import {
  NO_ATTEMPTS,
  PIN_ATTEMPTS_KEY,
  PIN_KEY,
  backoffAfterFailure,
  clampAttempts,
  createPinRecord,
  isLockedOut,
  sanitizeAttempts,
  sanitizePinRecord,
  verifyPin,
  fromB64,
  toB64,
} from "../lib/pin.js";
import type { HouseholdRole } from "../lib/gate.js";
import { decideMutation, needsWait, type DelayAction } from "../lib/delay.js";
import type { ManagedPolicy } from "../lib/managed.js";
import {
  ADULT_LISTED_ERROR,
  listedUnder,
  normalizeDomainInput,
  rulesetDomains,
} from "../lib/userRules.js";
import { promptDialog } from "./dialogs.js";
import { readDelay, showHold } from "./delay.js";

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
  readDeviceDisabled: async () =>
    sanitizeDisabled((await chrome.storage.local.get(DISABLED_CATEGORIES_KEY))[DISABLED_CATEGORIES_KEY]),
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

async function loadPinState(localOnly = false) {
  const stored = await chrome.storage.local.get([
    PIN_KEY,
    PIN_ATTEMPTS_KEY,
    HOUSEHOLD_STATE_KEY,
  ]);
  // In a household the PIN is the household's, synced in its state. This
  // browser's own copy is only written by setGuardianPin here, so a browser
  // that joined had no PIN and gated nothing: the pairing code alone was
  // enough to loosen the household or replace its PIN.
  // `localOnly`: joining asks for this browser's own PIN, never a
  // household's (a PIN kept from an earlier household stays here).
  const household = sanitizeHouseholdState(stored[HOUSEHOLD_STATE_KEY]);
  return {
    record:
      (household.ok && !localOnly ? household.value.pin : undefined) ??
      sanitizePinRecord(stored[PIN_KEY]),
    attempts: sanitizeAttempts(stored[PIN_ATTEMPTS_KEY]),
  };
}

/** The page's dialogs. Tests pass their own. */
export interface GateUi {
  prompt: typeof promptDialog;
  hold: typeof showHold;
}
const PAGE_UI: GateUi = { prompt: promptDialog, hold: showHold };

/** Holds (and offers the wait) when `kind` must wait now. True = held. */
async function heldByDelay(kind: DelayAction, ui: GateUi): Promise<boolean> {
  const d = await readDelay();
  if (!needsWait(kind, d.phase)) return false;
  await ui.hold(d);
  return true;
}

/**
 * Run `action` behind the mutation gate, then the "wait before loosening"
 * delay, then the PIN — the order decideMutation fixes. Holds (and offers
 * to start the wait) when the delay says so; prompts for the PIN when the
 * gate requires it; persists failed-attempt state BEFORE reporting
 * failure. Returns false when the action did not run.
 */
export async function withGate(
  kind: DelayAction,
  ctx: HouseholdContext,
  action: () => Promise<void>,
  ui: GateUi = PAGE_UI,
): Promise<boolean> {
  const { record, attempts } = await loadPinState(kind === "joinHousehold");
  const delay = await readDelay();
  const step = decideMutation(
    kind,
    { managed: ctx.managed, role: ctx.role, hasPin: record !== undefined },
    delay.phase,
  );
  if (step.step === "refused") {
    ctx.showError(
      step.reason === "managed-locked"
        ? "Settings are locked by your organization's administrator."
        : "This setting can only be changed from a guardian device.",
    );
    return false;
  }
  if (step.step === "wait") {
    await ui.hold(delay);
    return false;
  }
  if (step.step === "pin" && record !== undefined) {
    const now = Date.now();
    const clamped = clampAttempts(attempts, now);
    if (clamped !== attempts) {
      await chrome.storage.local.set({ [PIN_ATTEMPTS_KEY]: clamped });
    }
    const lock = isLockedOut(clamped, now);
    if (!lock.ok) {
      const seconds = Math.ceil((lock.error.retryAt - now) / 1000);
      ctx.showError(`Too many wrong PIN attempts — try again in ${seconds}s.`);
      return false;
    }
    const entered = await ui.prompt(
      kind === "joinHousehold"
        ? "Enter this browser's PIN to join a household:"
        : "Enter the guardian PIN:",
      { password: true },
    );
    if (entered === null) return false;
    if (!(await verifyPin(entered, record))) {
      const next = backoffAfterFailure(attempts.count, Date.now());
      await chrome.storage.local.set({ [PIN_ATTEMPTS_KEY]: next });
      ctx.showError("Wrong PIN.");
      return false;
    }
    await chrome.storage.local.set({ [PIN_ATTEMPTS_KEY]: NO_ATTEMPTS });
    // The PIN prompt can sit open past the window: re-check before acting.
    if (await heldByDelay(kind, ui)) return false;
  }
  await action();
  return true;
}

/* --------------------------- household actions -------------------------- */

// The extension syncs by itself (on join, then every 30 minutes); this page
// does not re-read the state, hence "reopen".
export const WAITING_FOR_FIRST_SYNC =
  "Waiting for the first sync with your household. Connect to the internet, " +
  "then reopen this page. The household's PIN and lists appear here after that.";

/** Not before the first sync: see isJoinPlaceholder. Shows why, returns true. */
function refuseBeforeFirstSync(ctx: HouseholdContext): boolean {
  if (ctx.state === undefined || !isJoinPlaceholder(ctx.state)) return false;
  ctx.showError(WAITING_FOR_FIRST_SYNC);
  return true;
}

async function saveMutatedState(
  ctx: HouseholdContext,
  mutate: (s: HouseholdState) => HouseholdState,
): Promise<void> {
  if (ctx.state === undefined || refuseBeforeFirstSync(ctx)) return;
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

/**
 * The sync endpoint is a background-only origin the user never visits, so
 * Safari's visit-a-site-then-grant flow can never grant it — it must be
 * requested explicitly inside the create/join user gesture. On Chrome the
 * origin is granted at install and this resolves true without a prompt.
 * Called FIRST in the gesture: Safari drops gesture context across awaits.
 */
async function requestSyncOrigin(ctx: HouseholdContext): Promise<boolean> {
  try {
    const granted = await chrome.permissions.request({
      origins: ["https://sync.sitrshield.com/*"],
    });
    if (!granted) {
      ctx.showError(
        "Family sync needs permission to reach sync.sitrshield.com — " +
          "nothing was set up.",
      );
    }
    return granted;
  } catch (e) {
    ctx.showError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

export async function createHousehold(ctx: HouseholdContext): Promise<boolean> {
  if (!(await requestSyncOrigin(ctx))) return false;
  const secret = generateRootSecret();
  const state = emptyHouseholdState(await deviceId(), Date.now());
  const applied = await applyHouseholdState(
    state,
    ctx.managed.forcedCategories,
    engineDeps,
  );
  if (!applied.ok) {
    ctx.showError(`Could not create household: ${applied.error}`);
    return false;
  }
  await chrome.storage.local.set({
    [HOUSEHOLD_SECRET_KEY]: toB64(secret),
    [HOUSEHOLD_ROLE_KEY]: "guardian",
  });
  ctx.role = "guardian";
  ctx.state = state;
  return true;
}

/**
 * Joining replaces this device's settings with the household's (by sync,
 * within seconds), so it is a loosening: held by the wait like
 * disableCategory, and it asks for this browser's own PIN when one is set
 * (decideMutation "joinHousehold"). Never refused by the managed lock or
 * the child role: it never was.
 */
export async function joinHousehold(
  ctx: HouseholdContext,
  code: string,
  role: HouseholdRole,
  ui: GateUi = PAGE_UI,
): Promise<boolean> {
  if (!(await requestSyncOrigin(ctx))) return false;
  const secret = decodePairingCode(code);
  if (!secret.ok) {
    ctx.showError(secret.error);
    return false;
  }
  let joined = false;
  await withGate("joinHousehold", ctx, async () => {
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
    joined = true;
  }, ui);
  return joined;
}

/**
 * A child device leaves only with proof of guardianship: the pairing code.
 * The wait before loosening applies on top, checked before the prompt and
 * again after it (the prompt can sit open past the window).
 */
export async function leaveAsChild(
  ctx: HouseholdContext,
  ui: GateUi = PAGE_UI,
): Promise<boolean> {
  if (await heldByDelay("leaveHousehold", ui)) return false;
  const code = await ui.prompt(
    "Enter the household pairing code (from a guardian device) to remove this device:",
  );
  if (code === null) return false;
  const secret = decodePairingCode(code);
  const stored = await chrome.storage.local.get(HOUSEHOLD_SECRET_KEY);
  const known =
    typeof stored[HOUSEHOLD_SECRET_KEY] === "string"
      ? fromB64(stored[HOUSEHOLD_SECRET_KEY])
      : undefined;
  const matches =
    secret.ok &&
    known?.ok === true &&
    known.value.length === secret.value.length &&
    known.value.every((b, i) => b === secret.value[i]);
  if (!matches) {
    ctx.showError("That pairing code does not match this household.");
    return false;
  }
  if (await heldByDelay("leaveHousehold", ui)) return false;
  await leaveHousehold(ctx);
  return true;
}

/**
 * Leaving: remove the household rule layer from the engine, forget the
 * keys, then take this device off the household's device list (unenroll)
 * with the key held only in memory — key first, so a sync round still on
 * the network finds no household and cannot bring it back. Offline, the
 * device leaves anyway and its place stays taken (options.html says so).
 */
export async function leaveHousehold(
  ctx: HouseholdContext,
  sync: SyncDeps = { fetch: fetch.bind(globalThis), now: () => Date.now() },
): Promise<void> {
  const before = await chrome.storage.local.get([
    HOUSEHOLD_SECRET_KEY,
    HOUSEHOLD_STATE_KEY,
    MAX_SEEN_REV_KEY,
    "entitlementToken",
  ]);
  const me = await deviceId();
  const cleared = { ...emptyHouseholdState(me, Date.now()) };
  cleared.allowDomains = [];
  cleared.blockDomains = [];
  // Passed as `stored` too: persisting it while the secret is still stored
  // would start a sync round of the cleared state.
  const applied = await applyHouseholdState(
    cleared,
    ctx.managed.forcedCategories,
    engineDeps,
    cleared,
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
  const secret =
    typeof before[HOUSEHOLD_SECRET_KEY] === "string"
      ? fromB64(before[HOUSEHOLD_SECRET_KEY])
      : undefined;
  const state = sanitizeHouseholdState(before[HOUSEHOLD_STATE_KEY]);
  if (secret?.ok !== true || !state.ok) return;
  await ctx.onChanged(); // show the page as left while the request runs
  await unenroll(
    {
      rootSecret: secret.value,
      local: state.value,
      maxSeenRev:
        typeof before[MAX_SEEN_REV_KEY] === "number" ? before[MAX_SEEN_REV_KEY] : 0,
      deviceId: me,
      entitlement:
        typeof before["entitlementToken"] === "string"
          ? before["entitlementToken"]
          : undefined,
    },
    sync,
  );
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

let adultList: Promise<Set<string>> | undefined;

/**
 * An allow entry for an adult-listed name is refused, saying why: it could
 * not open the site (the adult rules outrank every allow layer). The
 * packaged adult ruleset is read once per page. Entries that arrive
 * without an add screen (sync, managed policy, stored before) are not
 * refused; they just lose to the adult rules. Unreadable: not refused.
 */
export async function refusedAsAdult(
  domain: string,
  showError: (message: string) => void,
): Promise<boolean> {
  const url = "../../rulesets/adult.json"; // not a literal: tsc must not resolve it
  adultList ??= import(url, { with: { type: "json" } }).then(
    (m: { default: unknown }) => rulesetDomains(m.default),
    () => new Set<string>(),
  );
  if (!listedUnder(domain, await adultList)) return false;
  showError(ADULT_LISTED_ERROR);
  return true;
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
  if (kind === "allow" && (await refusedAsAdult(domain.value, ctx.showError))) return;
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
  // Before the local PIN write too, or the joiner still sets a PIN here.
  if (refuseBeforeFirstSync(ctx)) return;
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
