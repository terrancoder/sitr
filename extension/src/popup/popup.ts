/**
 * Popup: read-only view of protection status. No settings mutation here yet;
 * defaults to showing INACTIVE until proven otherwise (CLAUDE.md §4).
 */
import type { ProtectionStatus } from "../lib/status.js";
import {
  DISABLED_CATEGORIES_KEY,
  sanitizeDisabled,
  TOGGLEABLE_CATEGORIES,
} from "../lib/categories.js";

const statusEl = document.getElementById("status");
const textEl = document.getElementById("status-text");
const detailEl = document.getElementById("detail");
const breakdownEl = document.getElementById("breakdown");

/**
 * The protection breakdown makes otherwise-invisible protections visible
 * (YouTube Restricted Mode has no on-page indicator, which reads as "not
 * working"). Only rendered when protection is proven active — in any other
 * state the red INACTIVE banner is the whole message.
 */
function renderBreakdown(disabledStored: unknown): void {
  if (!breakdownEl) return;
  breakdownEl.textContent = "";
  const disabled = new Set<string>(sanitizeDisabled(disabledStored));
  const rows: Array<[string, boolean]> = [
    ["Adult content blocking", true],
    ...TOGGLEABLE_CATEGORIES.map(
      (c): [string, boolean] => [
        `${c.label} blocking`,
        !disabled.has(c.rulesetId),
      ],
    ),
    ["SafeSearch (Google, Bing, DuckDuckGo)", true],
    ["YouTube Restricted Mode", true],
  ];
  for (const [label, on] of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = label;
    const state = document.createElement("span");
    state.className = on ? "on" : "off";
    state.textContent = on ? "enforced" : "off";
    li.append(name, state);
    breakdownEl.append(li);
  }
}

function render(status: ProtectionStatus | undefined): void {
  if (!statusEl || !textEl || !detailEl) return;
  if (status?.state === "active") {
    statusEl.className = "status active";
    textEl.textContent = "Protection active";
    detailEl.textContent = "";
  } else {
    statusEl.className = "status inactive";
    textEl.textContent = "Protection INACTIVE";
    detailEl.textContent =
      status?.state === "inactive"
        ? `Rulesets not loaded: ${status.missingRulesets.join(", ")}. Try reloading the extension.`
        : status?.state === "unknown"
          ? `Could not verify protection: ${status.reason}`
          : "Status has not been reported yet. Try reloading the extension.";
  }
}

chrome.storage.local
  .get(["protectionStatus", DISABLED_CATEGORIES_KEY])
  .then((v) => {
    const status = v["protectionStatus"] as ProtectionStatus | undefined;
    render(status);
    if (status?.state === "active") {
      renderBreakdown(v[DISABLED_CATEGORIES_KEY]);
    }
  })
  .catch((e: unknown) => {
    render({
      state: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    });
  });
