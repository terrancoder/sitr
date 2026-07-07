/**
 * Sitr background service worker.
 *
 * Responsibilities (and nothing else — CLAUDE.md §7, single purpose):
 *  - verify the bundled DNR rulesets are actually enabled
 *  - surface "Protection inactive" visibly (badge + stored status) when not
 *
 * This worker makes NO network requests. Filtering is done entirely by the
 * browser's DNR engine from the bundled static rulesets.
 */
import { badgeFor, deriveStatus, type ProtectionStatus } from "../lib/status.js";
import {
  DISABLED_CATEGORIES_KEY,
  requiredRulesets,
  sanitizeDisabled,
} from "../lib/categories.js";

async function checkProtection(): Promise<ProtectionStatus> {
  try {
    const stored = await chrome.storage.local.get(DISABLED_CATEGORIES_KEY);
    const required = requiredRulesets(
      sanitizeDisabled(stored[DISABLED_CATEGORIES_KEY]),
    );
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    return deriveStatus(enabled, required);
  } catch (e) {
    // Fail visible, fail safe: an error querying rulesets means we cannot
    // prove protection — report unknown, which renders as a red badge.
    return {
      state: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function renderStatus(status: ProtectionStatus): Promise<void> {
  const badge = badgeFor(status);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setTitle({ title: badge.title });
  // Stored locally only, for the popup to read. Never transmitted.
  await chrome.storage.local.set({ protectionStatus: status });
}

async function refresh(): Promise<void> {
  const status = await checkProtection();
  if (status.state !== "active") {
    // Developer-facing log: state only — no URLs, no identifiers (§4).
    console.error("[sitr] protection not active:", status);
  }
  await renderStatus(status);
}

chrome.runtime.onInstalled.addListener(() => void refresh());
chrome.runtime.onStartup.addListener(() => void refresh());
// Re-check whenever settings change (the options page toggles categories).
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refresh();
});
void refresh();
