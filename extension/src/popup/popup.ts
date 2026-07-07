/**
 * Popup: read-only view of protection status. No settings mutation here yet;
 * defaults to showing INACTIVE until proven otherwise (CLAUDE.md §4).
 */
import type { ProtectionStatus } from "../lib/status.js";

const statusEl = document.getElementById("status");
const textEl = document.getElementById("status-text");
const detailEl = document.getElementById("detail");

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
  .get("protectionStatus")
  .then((v) => render(v["protectionStatus"] as ProtectionStatus | undefined))
  .catch((e: unknown) => {
    render({
      state: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    });
  });
