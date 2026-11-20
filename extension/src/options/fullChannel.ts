/**
 * Full-channel-only options wiring: household CREATION and the Sitr Family
 * subscription code (or, until the cut-over, a subscription token) — the
 * purchase-adjacent surface (docs/sync-protocol.md §Extension and Android).
 *
 * This module exists so store builds can exclude it STRUCTURALLY: the Mac
 * App Store bundle must not contain purchase-steering copy (guideline
 * 3.1.1; enforced by the stager's grep gate and the store risk register),
 * so `stage-safari.mjs --channel mas` omits this file and strips the
 * `#full-channel-only` block from options.html. options.ts loads this
 * module dynamically only when that block exists, which keeps Chrome and
 * Developer ID builds exactly as before — join-only stores still sync via
 * a household created on a full-channel device.
 *
 * The background claims and renews (background/fullChannel.ts); this page
 * claims only to create a household, and when the user moves the renewal
 * here. Any other change it stores and leaves to the next sync round.
 */
import {
  TEXTS,
  classifyCodeInput,
  emptyClaimState,
  forgetClaims,
  notice,
  offersReplace,
  record,
  sanitizeClaimState,
  userRetry,
  type ClaimOutcome,
  type ClaimReason,
  type ClaimState,
} from "../lib/entitlement.js";
import { isLapsed } from "../lib/householdEnd.js";
import { isJoinPlaceholder } from "../lib/household.js";
import { FAMILY_CODE_GATED_AS } from "../lib/gate.js";
import { CLAIM_BASE_URL } from "../lib/sync/client.js";
import { claim } from "../lib/sync/claimClient.js";
import { newClaimSecret } from "../lib/sync/renew.js";
import {
  CLAIM_SECRET_KEY,
  CLAIM_STATE_KEY,
  SUBSCRIPTION_CODE_KEY,
} from "../background/fullChannel.js";
import {
  PAGE_UI,
  createHouseholdGranted,
  endLine,
  formatDay,
  hasGuardianPin,
  refuseIfInHousehold,
  requestSyncOrigin,
  setGuardianPin,
  withGate,
  type GateUi,
  type HouseholdContext,
} from "./household.js";

const ENTITLEMENT_KEY = "entitlementToken";
const CLAIM_ORIGIN = `${CLAIM_BASE_URL}/*`;
/** The service worker's sync alarm (background/service-worker.ts). */
const SYNC_ALARM = "sitr-sync";

/** Asked before a rebind, on creation too: re-creating a household with
 * the same subscription in the same month always needs it. */
export const MOVE_QUESTION =
  "Renew on this browser? This can be moved once every 180 days.";
export const REMOVE_QUESTION =
  "Remove the subscription code? Renewals stop on this browser; the household keeps running until its end date.";
export const LEAVE_QUESTION =
  "This browser renews the Family plan. Leaving removes the subscription code from it.";
export const NEEDS_CLAIM_ACCESS =
  "Allow access to claim.sitrshield.com so this browser can renew the Family plan.";
export const CLAIM_UNAVAILABLE =
  "The subscription service could not be reached. Nothing was set up; try again in a moment.";
export const RENEWS_HERE = "This browser renews the Family plan.";
export const CODE_SAVED = "A subscription code is saved on this browser.";

const pageFetch: typeof fetch = (...args) => fetch(...args);

const fill = (text: string, ms: number | null) =>
  ms === null ? text : text.replace("{date}", formatDay(ms));

function refusalText(reason: ClaimReason, retryAfter: number | null): string {
  return fill(TEXTS[reason], retryAfter);
}

/**
 * The household's end and plan lines on this browser (pure). The notice
 * (entitlement.ts `notice`) when there is one, else the end date; then
 * what this browser's own code needs: the claim host's permission, or the
 * last refusal it got.
 */
export function familyLines(
  s: ClaimState,
  now: number,
  holdsCode: boolean,
  permitted: boolean,
): string[] {
  const lines: string[] = [];
  const n = notice(s, now, holdsCode);
  if (n === "enter-code") lines.push(fill(TEXTS["enter-code"], s.entExp));
  else if (n === "replacement-used") lines.push(fill(TEXTS[n], s.retryAfter));
  else if (n !== "none") lines.push(TEXTS[n]);
  else if (s.entExp !== null) lines.push(endLine(s, now));
  if (holdsCode && !permitted) lines.push(NEEDS_CLAIM_ACCESS);
  else if (holdsCode && s.lastRefusal !== null && (n === "none" || n === "waiting")) {
    lines.push(refusalText(s.lastRefusal, s.retryAfter));
  }
  return lines;
}

interface Stored {
  code: string | null;
  secret: string | null;
  state: ClaimState;
}

async function readStored(): Promise<Stored> {
  const got = await chrome.storage.local.get([
    SUBSCRIPTION_CODE_KEY,
    CLAIM_SECRET_KEY,
    CLAIM_STATE_KEY,
  ]);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    code: str(got[SUBSCRIPTION_CODE_KEY]),
    secret: str(got[CLAIM_SECRET_KEY]),
    state: sanitizeClaimState(got[CLAIM_STATE_KEY]),
  };
}

const claimPermitted = () => chrome.permissions.contains({ origins: [CLAIM_ORIGIN] });

/** A sync round now: the worker's own alarm, fired at once and kept at
 * its 30-minute period. ponytail: a browser may delay a `when` alarm (packed
 * Chrome is said to, by up to 30 seconds; not measured); a message to the
 * worker would be immediate, but the worker has no listener for one. */
async function startRound(): Promise<void> {
  await chrome.alarms.create(SYNC_ALARM, { when: Date.now(), periodInMinutes: 30 });
}

/** Stores the code with its claim secret, kept when the same code is
 * entered again (a new secret would cost the rebind). Returns the secret. */
async function keepCode(code: string, forget: boolean): Promise<string> {
  const s = await readStored();
  const secret = s.code === code && s.secret !== null ? s.secret : newClaimSecret();
  await chrome.storage.local.set({
    [SUBSCRIPTION_CODE_KEY]: code,
    [CLAIM_SECRET_KEY]: secret,
    ...(forget ? { [CLAIM_STATE_KEY]: forgetClaims(s.state) } : {}),
  });
  return secret;
}

async function forgetCode(): Promise<void> {
  await chrome.storage.local.remove([SUBSCRIPTION_CODE_KEY, CLAIM_SECRET_KEY]);
}

/** Shows a claim that gave no token; true for a token. */
async function handleOutcome(ctx: HouseholdContext, outcome: ClaimOutcome): Promise<boolean> {
  switch (outcome.kind) {
    case "token":
      return true;
    case "not-family":
      await forgetCode();
      ctx.showError(TEXTS["plan-not-accepted"]);
      return false;
    case "refused":
      ctx.showError(refusalText(outcome.reason, outcome.retryAfter));
      return false;
    case "unavailable":
      ctx.showError(CLAIM_UNAVAILABLE);
      return false;
  }
}

async function askMove(ui: GateUi): Promise<boolean> {
  return (await ui.prompt(MOVE_QUESTION, { noInput: true, confirmLabel: "Renew here" })) !== null;
}

/** Rule (a): claim, asking before the rebind; a token creates the household. */
async function createWithCode(
  ctx: HouseholdContext,
  code: string,
  ui: GateUi,
  fetchFn: typeof fetch,
): Promise<boolean> {
  // Stored before the claim can bind it: a lost secret costs the rebind.
  const claimSecret = await keepCode(code, false);
  const send = (replace: boolean) =>
    claim({ credential: code, claimSecret, replace, current: false }, { fetch: fetchFn });
  let outcome = await send(false);
  if (outcome.kind === "refused" && outcome.reason === "bound-to-other-device") {
    if (!(await askMove(ui))) return false;
    outcome = await send(true);
  }
  if (!(await handleOutcome(ctx, outcome))) return false;
  // The background sends the token on the creating write.
  await chrome.storage.local.set({
    [CLAIM_STATE_KEY]: record(emptyClaimState(), outcome, false, Date.now()),
  });
  return createHouseholdGranted(ctx);
}

/** As before: a new household's guardian is asked for a PIN. */
async function afterCreate(ctx: HouseholdContext, ui: GateUi): Promise<void> {
  if (!(await hasGuardianPin())) {
    const pin = await ui.prompt(
      "Set a guardian PIN (4–32 characters). It will be required to loosen protection:",
      { password: true },
    );
    if (pin !== null) await setGuardianPin(ctx, pin);
  }
  await ctx.onChanged();
}

/**
 * The one input field. With no household: create one (with a code, a
 * version 1 token as before, or nothing). In a household (a guardian
 * device): store the code and let the next round claim (rule (b)).
 * Returns true when something was created or stored.
 */
export async function submitCode(
  ctx: HouseholdContext,
  raw: string,
  ui: GateUi = PAGE_UI,
  fetchFn: typeof fetch = pageFetch,
): Promise<boolean> {
  const input = classifyCodeInput(raw);
  const inHousehold = ctx.state !== undefined;
  if (input.kind === "invalid" && (inHousehold || raw.trim() !== "")) {
    ctx.showError(TEXTS["input-invalid"]);
    return false;
  }
  if (input.kind !== "code") {
    if (inHousehold) {
      // A version 1 token, stored as before (ungated, as it always was).
      if (input.kind === "v1-token") await chrome.storage.local.set({ [ENTITLEMENT_KEY]: input.token });
      return input.kind === "v1-token";
    }
    if (!(await requestSyncOrigin(ctx))) return false; // first await: Safari's gesture
    if (input.kind === "v1-token") await chrome.storage.local.set({ [ENTITLEMENT_KEY]: input.token });
    const created = await createHouseholdGranted(ctx);
    if (created) await afterCreate(ctx, ui);
    return created;
  }
  // First await: Safari drops the user gesture across awaits.
  if (!(await requestSyncOrigin(ctx, [CLAIM_ORIGIN]))) return false;
  // Again in createHouseholdGranted, after the claim and its question.
  if (!inHousehold && (await refuseIfInHousehold(ctx))) return false;
  let done = false;
  await withGate(FAMILY_CODE_GATED_AS, ctx, async () => {
    if (inHousehold) {
      await keepCode(input.code, true);
      await startRound();
      done = true;
    } else {
      done = await createWithCode(ctx, input.code, ui, fetchFn);
    }
  }, ui);
  if (done && !inHousehold) await afterCreate(ctx, ui);
  return done;
}

/** "Remove code": asked, then gated. The household runs on until E. */
export async function removeCode(ctx: HouseholdContext, ui: GateUi = PAGE_UI): Promise<string | null> {
  if ((await ui.prompt(REMOVE_QUESTION, { noInput: true, confirmLabel: "Remove code" })) === null) return null;
  let entExp: number | null = null;
  const done = await withGate(FAMILY_CODE_GATED_AS, ctx, async () => {
    const s = await readStored();
    entExp = s.state.entExp;
    await forgetCode();
    await chrome.storage.local.set({ [CLAIM_STATE_KEY]: forgetClaims(s.state) });
  }, ui);
  if (!done) return null;
  if (entExp === null) return TEXTS["code-removed"].replace(/ The household runs until \{date\}\.$/, "");
  return fill(TEXTS["code-removed"], entExp);
}

/** "Try again": lifts waits and stops, then a round. Not gated. */
export async function retryClaim(): Promise<void> {
  const s = await readStored();
  await chrome.storage.local.set({ [CLAIM_STATE_KEY]: userRetry(s.state) });
  await startRound();
}

/** "Renew on this browser": the rebind, asked and gated (offersReplace). */
export async function renewHere(
  ctx: HouseholdContext,
  ui: GateUi = PAGE_UI,
  fetchFn: typeof fetch = pageFetch,
): Promise<boolean> {
  // First await: Safari drops the user gesture across awaits.
  if (!(await chrome.permissions.request({ origins: [CLAIM_ORIGIN] }))) {
    ctx.showError(NEEDS_CLAIM_ACCESS);
    return false;
  }
  if (!(await askMove(ui))) return false;
  let got = false;
  await withGate(FAMILY_CODE_GATED_AS, ctx, async () => {
    const s = await readStored();
    if (s.code === null || s.secret === null) return;
    const now = Date.now();
    const current = isLapsed(s.state, now);
    const outcome = await claim(
      { credential: s.code, claimSecret: s.secret, replace: true, current },
      { fetch: fetchFn },
    );
    // ponytail: a round in flight can overwrite this write (same code).
    await chrome.storage.local.set({ [CLAIM_STATE_KEY]: record(s.state, outcome, current, now) });
    got = await handleOutcome(ctx, outcome);
    if (got) await startRound();
  }, ui);
  return got;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function renderFamily(ctx: HouseholdContext): Promise<void> {
  const inHousehold = ctx.state !== undefined;
  const placeholder = ctx.state !== undefined && isJoinPlaceholder(ctx.state);
  // A child device never holds a code; nor does a device waiting for its
  // household (the guardian tools are hidden then too).
  el("full-channel-only").hidden = inHousehold && (ctx.role !== "guardian" || placeholder);
  el("family-code-submit").textContent = inHousehold ? "Save code" : "Create a household (guardian)";
  const s = await readStored();
  const token = (await chrome.storage.local.get(ENTITLEMENT_KEY))[ENTITLEMENT_KEY];
  const holdsCode = s.code !== null;
  const permitted = await claimPermitted();
  const now = Date.now();
  el("family-status").textContent = holdsCode
    ? inHousehold ? RENEWS_HERE : CODE_SAVED
    : typeof token === "string" && token !== ""
      ? "Subscription token saved on this device."
      : "";
  el("family-remove").hidden = !holdsCode;
  el("family-allow").hidden = !holdsCode || permitted;
  el("family-retry").hidden =
    !holdsCode || !inHousehold || !(s.state.stopped || s.state.lastRefusal !== null || s.state.backoff !== null);
  el("family-replace").hidden = !holdsCode || !inHousehold || !offersReplace(s.state, now);
}

export async function wireFullChannel(ctx: HouseholdContext): Promise<void> {
  ctx.family = {
    keys: [SUBSCRIPTION_CODE_KEY, CLAIM_SECRET_KEY, CLAIM_STATE_KEY],
    confirmLeave: async (ui) =>
      (await readStored()).code === null ||
      (await ui.prompt(LEAVE_QUESTION, { noInput: true, confirmLabel: "Leave" })) !== null,
    endText: async (now) => {
      const s = await readStored();
      return familyLines(s.state, now, s.code !== null, await claimPermitted()).join(" ");
    },
  };
  const shown = ctx.onChanged;
  ctx.onChanged = async () => {
    await shown();
    await renderFamily(ctx);
  };
  /** `said`: a status the action returns, shown after the re-render. */
  const run = (action: () => Promise<unknown>) => {
    ctx.showError("");
    void action()
      .then(async (said) => {
        await ctx.onChanged();
        if (typeof said === "string") el("family-status").textContent = said;
      })
      .catch((e: unknown) => ctx.showError(e instanceof Error ? e.message : String(e)));
  };
  const input = el<HTMLInputElement>("family-code");
  el<HTMLFormElement>("family-code-form").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      if (await submitCode(ctx, input.value)) input.value = "";
    });
  });
  el("family-remove").addEventListener("click", () => run(() => removeCode(ctx)));
  el("family-retry").addEventListener("click", () => run(retryClaim));
  el("family-replace").addEventListener("click", () => run(() => renewHere(ctx)));
  el("family-allow").addEventListener("click", () =>
    run(async () => {
      // First await: Safari drops the user gesture across awaits.
      if ((await chrome.permissions.request({ origins: [CLAIM_ORIGIN] })) && ctx.state !== undefined) {
        await startRound();
      }
    }),
  );
  await renderFamily(ctx);
}
