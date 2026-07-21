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
import {
  EMPTY_MANAGED_POLICY,
  isCategoryLocked,
  isManaged,
  sanitizeManagedPolicy,
  type ManagedPolicy,
} from "../lib/managed.js";
import {
  addHouseholdDomain,
  createHousehold,
  hasGuardianPin,
  joinHousehold,
  leaveHousehold,
  loadHousehold,
  removeHouseholdDomain,
  setGuardianPin,
  showPairingCode,
  withGate,
  type HouseholdContext,
} from "./household.js";
import {
  SYNC_STATUS_KEY,
  describeSyncStatus,
  sanitizeSyncStatus,
} from "../lib/sync/status.js";

const errorEl = document.getElementById("error") as HTMLElement;

/** Loaded once at startup; managed policy only changes via admin push. */
let managedPolicy: ManagedPolicy = EMPTY_MANAGED_POLICY;

async function loadManagedPolicy(): Promise<void> {
  try {
    managedPolicy = sanitizeManagedPolicy(await chrome.storage.managed.get(null));
  } catch {
    managedPolicy = EMPTY_MANAGED_POLICY;
  }
}

/** Banner, read-only lock, and the managed rule lists. */
function renderManaged(): void {
  const banner = document.getElementById("managed-banner") as HTMLElement;
  if (isManaged(managedPolicy)) {
    banner.hidden = false;
    banner.textContent = managedPolicy.organizationName
      ? `This browser is managed by ${managedPolicy.organizationName}. Some settings are controlled by your administrator.`
      : "This browser is managed by your organization. Some settings are controlled by your administrator.";
  }
  if (managedPolicy.lockOptions) {
    for (const id of ["allow-form", "block-form"]) {
      const form = document.getElementById(id) as HTMLFormElement;
      for (const el of form.elements) {
        (el as HTMLInputElement | HTMLButtonElement).disabled = true;
      }
    }
  }
  const section = document.getElementById("managed-section") as HTMLElement;
  const lists = [
    ["block", managedPolicy.managedBlockDomains],
    ["allow", managedPolicy.managedAllowDomains],
  ] as const;
  if (lists.some(([, domains]) => domains.length > 0)) {
    section.hidden = false;
    for (const [kind, domains] of lists) {
      if (domains.length === 0) continue;
      const heading = document.getElementById(
        `managed-${kind}-heading`,
      ) as HTMLElement;
      heading.hidden = false;
      const listEl = document.getElementById(
        `managed-${kind}-list`,
      ) as HTMLElement;
      listEl.textContent = "";
      for (const domain of domains) {
        const li = document.createElement("li");
        li.className = "locked";
        li.textContent = domain;
        listEl.append(li);
      }
    }
  }
}

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
      li.append(span);
      if (!managedPolicy.lockOptions) {
        const button = document.createElement("button");
        button.textContent = "Remove";
        button.addEventListener("click", () => void removeRule(entry.id));
        li.append(button);
      }
      listEl.append(li);
    }
  }
}

async function addRule(kind: UserRuleKind, rawInput: string): Promise<void> {
  clearError();
  if (managedPolicy.lockOptions) {
    showError("Settings are locked by your organization's administrator.");
    return;
  }
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
  if (managedPolicy.lockOptions) {
    showError("Settings are locked by your organization's administrator.");
    return;
  }
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
    const forced = managedPolicy.forcedCategories.includes(category.rulesetId);
    checkbox.checked = forced || !disabled.has(category.rulesetId);
    if (isCategoryLocked(category.rulesetId, managedPolicy)) {
      checkbox.disabled = true;
      const tag = document.createElement("span");
      tag.className = "locked-tag";
      tag.textContent = forced ? "(required by your organization)" : "(locked)";
      label.append(checkbox, ` Block ${category.label.toLowerCase()} sites `, tag);
      li.append(label);
      listEl.append(li);
      continue;
    }
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

/* ------------------------------ household ------------------------------- */

const hh: HouseholdContext = {
  role: undefined,
  state: undefined,
  managed: EMPTY_MANAGED_POLICY,
  showError,
  onChanged: async () => {
    renderHousehold();
    await renderHouseholdLists();
  },
};

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function renderHousehold(): void {
  const none = el("household-none");
  const active = el("household-active");
  const guardianTools = el("household-guardian-tools");
  const blockTools = el("household-block-tools");
  if (hh.state === undefined) {
    none.hidden = false;
    active.hidden = true;
    return;
  }
  none.hidden = true;
  active.hidden = false;
  const isGuardian = hh.role === "guardian";
  guardianTools.hidden = !isGuardian;
  blockTools.hidden = !isGuardian;
  el("household-role-line").textContent = isGuardian
    ? "This is a guardian device. You can edit the household lists and show the pairing code."
    : "This is a child device. Household settings can only be changed from a guardian device.";
}

async function renderHouseholdLists(): Promise<void> {
  for (const kind of ["allow", "block"] as const) {
    const listEl = el(`household-${kind}-list`);
    listEl.textContent = "";
    const domains =
      kind === "allow"
        ? (hh.state?.allowDomains ?? [])
        : (hh.state?.blockDomains ?? []);
    if (hh.state !== undefined && domains.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent =
        kind === "allow"
          ? "No household-allowed sites."
          : "No household-blocked sites.";
      listEl.append(li);
      continue;
    }
    for (const domain of domains) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = domain;
      li.append(span);
      if (hh.role === "guardian" && !hh.managed.lockOptions) {
        const button = document.createElement("button");
        button.textContent = "Remove";
        button.addEventListener("click", () => {
          clearError();
          void withGate("removeHouseholdRule", hh, async () => {
            await removeHouseholdDomain(hh, kind, domain);
            await hh.onChanged();
          }).catch((e: unknown) => {
            showError(e instanceof Error ? e.message : String(e));
          });
        });
        li.append(button);
      }
      listEl.append(li);
    }
  }
  const stored = await chrome.storage.local.get(SYNC_STATUS_KEY);
  el("sync-status").textContent =
    hh.state !== undefined
      ? describeSyncStatus(sanitizeSyncStatus(stored[SYNC_STATUS_KEY]))
      : "";
}

function wireHousehold(): void {
  el("household-create").addEventListener("click", () => {
    clearError();
    void createHousehold(hh)
      .then(async () => {
        if (!(await hasGuardianPin())) {
          const pin = window.prompt(
            "Set a guardian PIN (4–32 characters). It will be required to loosen protection:",
          );
          if (pin !== null) await setGuardianPin(hh, pin);
        }
        await hh.onChanged();
      })
      .catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
  });

  el<HTMLFormElement>("household-join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    clearError();
    const code = el<HTMLInputElement>("household-join-code").value;
    const role =
      el<HTMLSelectElement>("household-join-role").value === "guardian"
        ? ("guardian" as const)
        : ("child" as const);
    void joinHousehold(hh, code, role)
      .then(() => hh.onChanged())
      .catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
  });

  el("household-show-code").addEventListener("click", () => {
    clearError();
    void withGate("changePin", hh, async () => {
      const code = await showPairingCode(hh);
      const codeEl = el("household-code");
      if (code !== undefined) {
        codeEl.hidden = false;
        codeEl.textContent = code;
      }
    }).catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
  });

  el("household-set-pin").addEventListener("click", () => {
    clearError();
    void withGate("changePin", hh, async () => {
      const pin = window.prompt("New guardian PIN (4–32 characters):");
      if (pin !== null) await setGuardianPin(hh, pin);
    }).catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
  });

  el("household-leave").addEventListener("click", () => {
    clearError();
    void (async () => {
      if (hh.role === "child") {
        // A child device leaves only with proof of guardianship: the code.
        const code = window.prompt(
          "Enter the household pairing code (from a guardian device) to remove this device:",
        );
        if (code === null) return;
        const { decodePairingCode } = await import("../lib/sync/crypto.js");
        const { fromB64 } = await import("../lib/pin.js");
        const secret = decodePairingCode(code);
        const stored = await chrome.storage.local.get("householdSecret");
        const known =
          typeof stored["householdSecret"] === "string"
            ? fromB64(stored["householdSecret"])
            : undefined;
        const matches =
          secret.ok &&
          known?.ok === true &&
          known.value.length === secret.value.length &&
          known.value.every((b, i) => b === secret.value[i]);
        if (!matches) {
          showError("That pairing code does not match this household.");
          return;
        }
        await leaveHousehold(hh);
        await hh.onChanged();
        return;
      }
      await withGate("leaveHousehold", hh, async () => {
        await leaveHousehold(hh);
        await hh.onChanged();
      });
    })().catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
  });

  for (const kind of ["allow", "block"] as const) {
    const form = el<HTMLFormElement>(`household-${kind}-form`);
    const input = el<HTMLInputElement>(`household-${kind}-input`);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      clearError();
      const gateKind =
        kind === "allow" ? ("addDeviceAllowRule" as const) : ("addHouseholdRule" as const);
      void withGate(gateKind, hh, async () => {
        await addHouseholdDomain(hh, kind, input.value);
        input.value = "";
        await hh.onChanged();
      }).catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
    });
  }
}

wireForm("allow");
wireForm("block");
wireHousehold();
void (async () => {
  await loadManagedPolicy();
  hh.managed = managedPolicy;
  const loaded = await loadHousehold();
  hh.role = loaded.role;
  hh.state = loaded.state;
  renderManaged();
  renderHousehold();
  await renderCategories();
  await refreshLists();
  await renderHouseholdLists();
})().catch((e: unknown) => {
  showError(
    `Could not load settings: ${e instanceof Error ? e.message : String(e)}`,
  );
});
