/**
 * Full-channel-only options wiring: household CREATION and the Sitr Family
 * entitlement token — the purchase-adjacent surface.
 *
 * This module exists so store builds can exclude it STRUCTURALLY: the Mac
 * App Store bundle must not contain purchase-steering copy (guideline
 * 3.1.1; enforced by the stager's grep gate and the store risk register),
 * so `stage-safari.mjs --channel mas` omits this file and strips the
 * `#full-channel-only` block from options.html. options.ts loads this
 * module dynamically only when that block exists, which keeps Chrome and
 * Developer ID builds exactly as before — join-only stores still sync via
 * a household created on a full-channel device.
 */
import {
  createHousehold,
  hasGuardianPin,
  setGuardianPin,
  type HouseholdContext,
} from "./household.js";
import { promptDialog } from "./dialogs.js";

const ENTITLEMENT_KEY = "entitlementToken";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function renderEntitlement(): Promise<void> {
  const stored = await chrome.storage.local.get(ENTITLEMENT_KEY);
  el("entitlement-status").textContent =
    typeof stored[ENTITLEMENT_KEY] === "string" && stored[ENTITLEMENT_KEY] !== ""
      ? "Subscription token saved on this device."
      : "Sitr Family sync needs a subscription token from sitrshield.com/family (creating a household on the official server requires it).";
}

export async function wireFullChannel(ctx: HouseholdContext): Promise<void> {
  el("entitlement-enter").addEventListener("click", () => {
    ctx.showError("");
    void (async () => {
      const token = await promptDialog(
        "Paste your Sitr Family subscription token (from the checkout page):",
      );
      if (token === null) return;
      const trimmed = token.trim();
      if (!trimmed.startsWith("sitr-ent-v1.")) {
        ctx.showError(
          'That does not look like a token (it starts with "sitr-ent-v1.").',
        );
        return;
      }
      await chrome.storage.local.set({ [ENTITLEMENT_KEY]: trimmed });
      await renderEntitlement();
    })().catch((e: unknown) =>
      ctx.showError(e instanceof Error ? e.message : String(e)),
    );
  });

  el("household-create").addEventListener("click", () => {
    ctx.showError("");
    void createHousehold(ctx)
      .then(async (created) => {
        if (!created) return;
        if (!(await hasGuardianPin())) {
          const pin = await promptDialog(
            "Set a guardian PIN (4–32 characters). It will be required to loosen protection:",
            { password: true },
          );
          if (pin !== null) await setGuardianPin(ctx, pin);
        }
        await ctx.onChanged();
      })
      .catch((e: unknown) =>
        ctx.showError(e instanceof Error ? e.message : String(e)),
      );
  });

  await renderEntitlement();
}
