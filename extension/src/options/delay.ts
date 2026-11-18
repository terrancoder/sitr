/**
 * "Wait before loosening" glue for the options page: storage, the hold
 * dialog withGate shows, and the settings section. The rules themselves
 * live in lib/delay.ts (shared with the mobile ports via delay.json).
 */
import {
  DELAY_MINUTES,
  DELAY_MINUTES_KEY,
  DELAY_REQUEST_KEY,
  WINDOW_MS,
  delayChangeAction,
  evaluate,
  sanitizeDelayMinutes,
  sanitizeDelayRequest,
  type DelayAction,
  type DelayEvaluation,
} from "../lib/delay.js";
import { promptDialog } from "./dialogs.js";
import type { HouseholdContext } from "./household.js";

export interface DelayState extends DelayEvaluation {
  minutes: number;
}

async function load(): Promise<{ state: DelayState; stored: number | null }> {
  const s = await chrome.storage.local.get([DELAY_MINUTES_KEY, DELAY_REQUEST_KEY]);
  const minutes = sanitizeDelayMinutes(s[DELAY_MINUTES_KEY]);
  const request = sanitizeDelayRequest(s[DELAY_REQUEST_KEY]);
  // ponytail: wall clock. Setting the computer's clock forward ends the wait
  // early (back only restarts it). Extensions get no monotonic clock that
  // survives a browser restart; the mobile ports use one.
  const ev = evaluate(minutes, request, Date.now());
  return { state: { minutes, ...ev }, stored: request?.at ?? null };
}

/** Evaluate now and persist the request only when evaluate changed it. */
export async function readDelay(): Promise<DelayState> {
  const { state, stored } = await load();
  if ((state.request?.at ?? null) !== stored) {
    if (state.request === null) await chrome.storage.local.remove(DELAY_REQUEST_KEY);
    else await chrome.storage.local.set({ [DELAY_REQUEST_KEY]: state.request });
  }
  return state;
}

function delayLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

async function startRequest(): Promise<void> {
  await chrome.storage.local.set({ [DELAY_REQUEST_KEY]: { at: Date.now() } });
}

async function cancelRequest(): Promise<void> {
  await chrome.storage.local.remove(DELAY_REQUEST_KEY);
}

/** withGate's hold step: the change does not happen; offer the next move. */
export async function showHold(d: DelayState): Promise<void> {
  if (d.phase === "idle") {
    const start = await promptDialog(
      `Changes that loosen protection are set to wait ${delayLabel(d.minutes)}. Start the wait?`,
      { noInput: true, confirmLabel: "Start", cancelLabel: "Cancel" },
    );
    if (start !== null) await startRequest();
    return;
  }
  // Only "Close": a habitual tap must never cancel a wait that is nearly
  // over. Cancelling stays in the settings section.
  await promptDialog(
    `Ready in ${formatRemaining(d.remainingMs)}. Then changes stay open for ` +
      `${WINDOW_MS / 60_000} minutes. Try the change again then. ` +
      `(To cancel the request, use "Cancel request" under Wait before loosening.)`,
    { noInput: true, noCancel: true, confirmLabel: "Close" },
  );
}

/* ------------------------------ the section ------------------------------ */

type Gate = (
  kind: DelayAction,
  ctx: HouseholdContext,
  action: () => Promise<void>,
) => Promise<boolean>;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function render(ctx: HouseholdContext): Promise<void> {
  // readDelay writes only when evaluate changed the request (restart or expiry).
  const d = await readDelay();
  const select = el<HTMLSelectElement>("delay-minutes");
  if (document.activeElement !== select) select.value = String(d.minutes);
  el("delay-status").textContent =
    d.phase === "off"
      ? "Off. Changes apply straight away."
      : d.phase === "idle"
        ? `On (${delayLabel(d.minutes)}). No request: changes that loosen protection are held until you start the wait and it runs out.`
        : d.phase === "waiting"
          ? `Ready in ${formatRemaining(d.remainingMs)}.`
          : `Changes open for ${formatRemaining(d.remainingMs)}.`;
  const locked = ctx.managed.lockOptions;
  select.disabled = locked;
  el<HTMLButtonElement>("delay-start").disabled = locked || d.phase !== "idle";
  el<HTMLButtonElement>("delay-cancel").disabled =
    locked || (d.phase !== "waiting" && d.phase !== "open");
}

export async function wireDelay(ctx: HouseholdContext, withGate: Gate): Promise<void> {
  const select = el<HTMLSelectElement>("delay-minutes");
  for (const minutes of DELAY_MINUTES) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = minutes === 0 ? "Off" : delayLabel(minutes);
    select.append(option);
  }
  const fail = (e: unknown) => ctx.showError(e instanceof Error ? e.message : String(e));

  select.addEventListener("change", () => {
    ctx.showError("");
    void (async () => {
      const from = (await readDelay()).minutes;
      const to = sanitizeDelayMinutes(Number(select.value));
      if (to === from) return;
      // Any change to the setting clears the request: a request made under
      // an old setting must never open the window early under a new one.
      const save = async () => {
        await chrome.storage.local.set({ [DELAY_MINUTES_KEY]: to });
        await cancelRequest();
      };
      const action = delayChangeAction(from, to);
      if (action !== null) await withGate(action, ctx, save);
      else if (ctx.managed.lockOptions) {
        ctx.showError("Settings are locked by your organization's administrator.");
      } else await save();
    })()
      .catch(fail)
      .finally(() => {
        select.blur();
        void render(ctx);
      });
  });
  el("delay-start").addEventListener("click", () => {
    void startRequest().then(() => render(ctx)).catch(fail);
  });
  el("delay-cancel").addEventListener("click", () => {
    void cancelRequest().then(() => render(ctx)).catch(fail);
  });

  await render(ctx);
  setInterval(() => void render(ctx).catch(fail), 1000);
}
