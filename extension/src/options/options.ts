/**
 * Options page: per-site allow/deny managed as DNR dynamic rules.
 *
 * The live dynamic rules are the single source of truth — the page reads
 * them back after every change, so what's shown is what's enforced. Every
 * failure is rendered in the page's error line, never swallowed (§4).
 */
import {
  DISABLED_CATEGORIES_KEY,
  sanitizeDisabled,
  TOGGLEABLE_CATEGORIES,
  type ToggleableRulesetId,
} from "../lib/categories.js";
import {
  buildUserRule,
  domainsOf,
  normalizeDomainInput,
  nextRuleId,
  type UserRuleKind,
} from "../lib/userRules.js";

const errorEl = document.getElementById("error") as HTMLElement;

function showError(message: string): void {
  errorEl.textContent = message;
}
function clearError(): void {
  errorEl.textContent = "";
}

async function refreshLists(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  for (const kind of ["allow", "block"] as const) {
    const listEl = document.getElementById(`${kind}-list`) as HTMLElement;
    listEl.textContent = "";
    const entries = domainsOf(rules, kind);
    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent =
        kind === "allow" ? "No allowed sites." : "No extra blocked sites.";
      listEl.append(li);
      continue;
    }
    for (const entry of entries) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = entry.domain;
      const button = document.createElement("button");
      button.textContent = "Remove";
      button.addEventListener("click", () => void removeRule(entry.id));
      li.append(span, button);
      listEl.append(li);
    }
  }
}

async function addRule(kind: UserRuleKind, rawInput: string): Promise<void> {
  clearError();
  const domain = normalizeDomainInput(rawInput);
  if (!domain.ok) {
    showError(domain.error);
    return;
  }
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (domainsOf(rules, kind).some((e) => e.domain === domain.value)) {
    return; // already present — idempotent, nothing to do
  }
  const id = nextRuleId(rules.map((r) => r.id), kind);
  if (!id.ok) {
    showError(id.error);
    return;
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    // Cast: our UserRule shape is a strict subset of chrome.dnr.Rule.
    addRules: [
      buildUserRule(kind, domain.value, id.value) as unknown as
        chrome.declarativeNetRequest.Rule,
    ],
  });
  await refreshLists();
}

async function removeRule(id: number): Promise<void> {
  clearError();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [id],
  });
  await refreshLists();
}

function wireForm(kind: UserRuleKind): void {
  const form = document.getElementById(`${kind}-form`) as HTMLFormElement;
  const input = document.getElementById(`${kind}-input`) as HTMLInputElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void addRule(kind, input.value)
      .then(() => {
        input.value = "";
      })
      .catch((e: unknown) => {
        showError(
          `Could not update rules: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  });
}

async function setCategoryDisabled(
  rulesetId: ToggleableRulesetId,
  disabled: boolean,
): Promise<void> {
  clearError();
  const stored = await chrome.storage.local.get(DISABLED_CATEGORIES_KEY);
  const current = new Set(sanitizeDisabled(stored[DISABLED_CATEGORIES_KEY]));
  if (disabled) current.add(rulesetId);
  else current.delete(rulesetId);

  // Apply to the DNR engine first; only persist the preference if that
  // succeeded, so settings never claim a state the engine doesn't have.
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    disabled
      ? { disableRulesetIds: [rulesetId] }
      : { enableRulesetIds: [rulesetId] },
  );
  await chrome.storage.local.set({ [DISABLED_CATEGORIES_KEY]: [...current] });
}

async function renderCategories(): Promise<void> {
  const listEl = document.getElementById("category-list") as HTMLElement;
  const stored = await chrome.storage.local.get(DISABLED_CATEGORIES_KEY);
  const disabled = new Set(sanitizeDisabled(stored[DISABLED_CATEGORIES_KEY]));
  listEl.textContent = "";
  for (const category of TOGGLEABLE_CATEGORIES) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !disabled.has(category.rulesetId);
    checkbox.addEventListener("change", () => {
      void setCategoryDisabled(category.rulesetId, !checkbox.checked).catch(
        (e: unknown) => {
          // Revert the checkbox so the UI never shows an unapplied state.
          checkbox.checked = !checkbox.checked;
          showError(
            `Could not update category: ${e instanceof Error ? e.message : String(e)}`,
          );
        },
      );
    });
    label.append(checkbox, ` Block ${category.label.toLowerCase()} sites`);
    li.append(label);
    listEl.append(li);
  }
}

wireForm("allow");
wireForm("block");
void renderCategories().catch((e: unknown) => {
  showError(
    `Could not load categories: ${e instanceof Error ? e.message : String(e)}`,
  );
});
void refreshLists().catch((e: unknown) => {
  showError(
    `Could not load rules: ${e instanceof Error ? e.message : String(e)}`,
  );
});
