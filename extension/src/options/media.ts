/**
 * Media-filter UI (threat-model T12): the tri-state mode, the image
 * allowlist (dynamic band), and the session-scoped "just this once" escape
 * hatch. Engine first, persist after; every failure surfaces in the page's
 * error line; loosening goes through the mutation gate like everything else.
 */
import {
  MEDIA_MODE_KEY,
  MEDIA_RULESETS,
  isMediaModeLoosening,
  mediaRulesets,
  sanitizeMediaMode,
  type MediaMode,
} from "../lib/categories.js";
import {
  IMAGE_ALLOW_PRIORITY,
  MAX_SESSION_ESCAPE_RULES,
  MEDIA_RESOURCE_TYPES,
  SESSION_ESCAPE_BASE,
  imageAllowSitesOf,
  planImageAllowUpdate,
  type LiveRule,
} from "../lib/ruleLayers.js";
import { normalizeDomainInput } from "../lib/userRules.js";
import { withGate, type HouseholdContext } from "./household.js";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/**
 * Session rules exist as a separate quota only on Chrome (Safari pools them
 * with dynamic rules AND has an open session-vs-static priority bug that
 * would make the hatch silently inert). Feature-gate on the constant Chrome
 * exposes and Safari doesn't, so the control never renders where it lies.
 */
function sessionEscapeSupported(): boolean {
  return (
    typeof (
      chrome.declarativeNetRequest as unknown as Record<string, unknown>
    )["MAX_NUMBER_OF_SESSION_RULES"] === "number"
  );
}

async function readMode(): Promise<MediaMode> {
  const stored = await chrome.storage.local.get(MEDIA_MODE_KEY);
  return sanitizeMediaMode(stored[MEDIA_MODE_KEY]);
}

async function setMode(next: MediaMode): Promise<void> {
  // Engine first (§4): enable what the mode needs, disable the rest, and
  // only persist the preference once the engine accepted it.
  const need = new Set(mediaRulesets(next));
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: [...need],
    disableRulesetIds: MEDIA_RULESETS.filter((id) => !need.has(id)),
  });
  await chrome.storage.local.set({ [MEDIA_MODE_KEY]: next });
}

async function renderMode(ctx: HouseholdContext): Promise<void> {
  const mode = await readMode();
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="media-mode"]',
  )) {
    radio.checked = radio.value === mode;
    radio.disabled = ctx.managed.lockOptions;
  }
  el("image-allowlist-section").hidden = mode !== "allowlist";
  el("session-escape-section").hidden =
    mode === "off" || !sessionEscapeSupported();
}

/* ----------------------------- image allowlist ---------------------------- */

async function renderImageAllowlist(ctx: HouseholdContext): Promise<void> {
  const rules = (await chrome.declarativeNetRequest.getDynamicRules()) as
    LiveRule[];
  const listEl = el("image-allow-list");
  listEl.textContent = "";
  const entries = imageAllowSitesOf(rules);
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites yet — images are hidden everywhere.";
    listEl.append(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = entry.domain;
    li.append(span);
    if (!ctx.managed.lockOptions) {
      const button = document.createElement("button");
      button.textContent = "Remove";
      button.addEventListener("click", () => {
        void withGate("removeImageAllowRule", ctx, async () => {
          await updateImageAllowlist(ctx, (sites) =>
            sites.filter((d) => d !== entry.domain),
          );
        }).catch((e: unknown) =>
          ctx.showError(e instanceof Error ? e.message : String(e)),
        );
      });
      li.append(button);
    }
    listEl.append(li);
  }
}

async function updateImageAllowlist(
  ctx: HouseholdContext,
  mutate: (sites: string[]) => string[],
): Promise<void> {
  const live = (await chrome.declarativeNetRequest.getDynamicRules()) as
    LiveRule[];
  const current = imageAllowSitesOf(live).map((e) => e.domain);
  const plan = planImageAllowUpdate(live, mutate(current));
  if (!plan.ok) {
    ctx.showError(plan.error);
    return;
  }
  if (plan.value.addRules.length > 0 || plan.value.removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: plan.value.addRules as chrome.declarativeNetRequest.Rule[],
      removeRuleIds: plan.value.removeRuleIds,
    });
  }
  await renderImageAllowlist(ctx);
}

/* --------------------------- session escape hatch ------------------------- */

async function renderSessionEscapes(ctx: HouseholdContext): Promise<void> {
  if (!sessionEscapeSupported()) return;
  const rules = (await chrome.declarativeNetRequest.getSessionRules()) as
    LiveRule[];
  const listEl = el("session-escape-list");
  listEl.textContent = "";
  const mine = rules.filter(
    (r) =>
      r.id >= SESSION_ESCAPE_BASE &&
      r.id < SESSION_ESCAPE_BASE + MAX_SESSION_ESCAPE_RULES,
  );
  for (const rule of mine) {
    for (const domain of rule.condition?.initiatorDomains ?? []) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = `${domain} (until the browser closes)`;
      li.append(span);
      const button = document.createElement("button");
      button.textContent = "Remove";
      button.addEventListener("click", () => {
        void chrome.declarativeNetRequest
          .updateSessionRules({ removeRuleIds: [rule.id] })
          .then(() => renderSessionEscapes(ctx))
          .catch((e: unknown) =>
            ctx.showError(e instanceof Error ? e.message : String(e)),
          );
      });
      li.append(button);
      listEl.append(li);
    }
  }
}

async function addSessionEscape(
  ctx: HouseholdContext,
  rawInput: string,
): Promise<void> {
  const domain = normalizeDomainInput(rawInput);
  if (!domain.ok) {
    ctx.showError(domain.error);
    return;
  }
  const rules = (await chrome.declarativeNetRequest.getSessionRules()) as
    LiveRule[];
  const used = new Set(
    rules
      .map((r) => r.id)
      .filter(
        (id) =>
          id >= SESSION_ESCAPE_BASE &&
          id < SESSION_ESCAPE_BASE + MAX_SESSION_ESCAPE_RULES,
      ),
  );
  let offset = 0;
  while (offset < MAX_SESSION_ESCAPE_RULES && used.has(SESSION_ESCAPE_BASE + offset)) {
    offset++;
  }
  if (offset >= MAX_SESSION_ESCAPE_RULES) {
    ctx.showError(
      `limit of ${MAX_SESSION_ESCAPE_RULES} session exceptions reached — remove one first`,
    );
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id: SESSION_ESCAPE_BASE + offset,
        priority: IMAGE_ALLOW_PRIORITY,
        action: { type: "allow" },
        condition: {
          initiatorDomains: [domain.value],
          resourceTypes: [...MEDIA_RESOURCE_TYPES],
        },
      } as unknown as chrome.declarativeNetRequest.Rule,
    ],
  });
  await renderSessionEscapes(ctx);
}

/* --------------------------------- wiring --------------------------------- */

export async function wireMedia(ctx: HouseholdContext): Promise<void> {
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="media-mode"]',
  )) {
    radio.addEventListener("change", () => {
      void (async () => {
        const current = await readMode();
        const next = sanitizeMediaMode(radio.value);
        if (next === current) return;
        const kind = isMediaModeLoosening(current, next)
          ? ("loosenMediaMode" as const)
          : ("tightenMediaMode" as const);
        const done = await withGate(kind, ctx, async () => {
          await setMode(next);
        });
        // Re-render from stored truth either way: a refused/cancelled gate
        // must snap the radio back, never show an unapplied state.
        await renderMode(ctx);
        if (done) await renderImageAllowlist(ctx);
      })().catch((e: unknown) => {
        ctx.showError(e instanceof Error ? e.message : String(e));
        void renderMode(ctx);
      });
    });
  }

  el<HTMLFormElement>("image-allow-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = el<HTMLInputElement>("image-allow-input");
    void withGate("addImageAllowRule", ctx, async () => {
      const domain = normalizeDomainInput(input.value);
      if (!domain.ok) {
        ctx.showError(domain.error);
        return;
      }
      await updateImageAllowlist(ctx, (sites) => [...sites, domain.value]);
      input.value = "";
    }).catch((e: unknown) =>
      ctx.showError(e instanceof Error ? e.message : String(e)),
    );
  });

  el<HTMLFormElement>("session-escape-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = el<HTMLInputElement>("session-escape-input");
    void withGate("addImageAllowRule", ctx, async () => {
      await addSessionEscape(ctx, input.value);
      input.value = "";
    }).catch((e: unknown) =>
      ctx.showError(e instanceof Error ? e.message : String(e)),
    );
  });

  await renderMode(ctx);
  await renderImageAllowlist(ctx);
  await renderSessionEscapes(ctx);
}
