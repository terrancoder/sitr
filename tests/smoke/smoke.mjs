/**
 * Real-browser smoke test: loads the built extension into Chrome and checks
 * the actual DNR behavior end-to-end. Zero dependencies — uses Chrome's
 * DevTools protocol over Node 22's built-in WebSocket.
 *
 * Not part of `npm test` (needs a local Chrome + network); run with:
 *   npm run build && node tests/smoke/smoke.mjs
 *
 * Checks:
 *   1. the extension service worker is running
 *   2. a blocklisted domain is blocked (ERR_BLOCKED_BY_CLIENT)
 *   3. an unlisted domain is NOT blocked (no over-blocking)
 *   4. all four rulesets are enabled (asked of the live DNR engine)
 *   5. SafeSearch rules match Google/Bing/YouTube (testMatchOutcome —
 *      deterministic, immune to search engines' bot-walls)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 9333;
const EXTENSION_DIR = resolve(import.meta.dirname, "../../extension");

// Branded Chrome/Edge ignore --load-extension since 137; a Chromium-based
// build (Chrome for Testing) is required. Override with SITR_CHROME.
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const CHROME_PATHS = [
  process.env.SITR_CHROME,
  join(home, ".cache/chrome-for-testing/chrome-win64/chrome.exe"),
  join(home, ".cache/chrome-for-testing/chrome-linux64/chrome"),
  join(
    home,
    ".cache/chrome-for-testing/chrome-mac-arm64/" +
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
  join(
    home,
    ".cache/chrome-for-testing/chrome-mac-x64/" +
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = CHROME_PATHS.find((p) => existsSync(p));
if (!chrome) {
  console.error(
    "SMOKE: no Chromium-based browser found (branded Chrome cannot " +
      "--load-extension). Download Chrome for Testing to " +
      "~/.cache/chrome-for-testing/ or set SITR_CHROME.",
  );
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), "sitr-smoke-"));
const proc = spawn(
  chrome,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
  ],
  { stdio: "ignore" },
);

const cleanup = () => {
  try {
    proc.kill();
  } catch (e) {
    console.error("SMOKE: could not kill chrome:", e.message);
  }
  // Windows keeps profile files locked briefly after kill.
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      console.error(`SMOKE: temp profile left behind at ${profile}`);
    }
  }, 1500).unref();
};
process.on("exit", cleanup);

async function waitForBrowser() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("browser did not expose DevTools endpoint");
}

const wsUrl = await waitForBrowser();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("websocket failed"));
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(`${msg.error.message}`));
    else res(msg.result);
  }
};

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => {
      if (pending.delete(id)) rej(new Error(`timeout: ${method}`));
    }, 15_000);
  });
}

const results = [];
function report(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// A page session to drive navigations.
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await send("Page.enable", {}, sessionId);

async function navigate(url) {
  const nav = await send("Page.navigate", { url }, sessionId);
  // Give redirects/loads a moment to settle before reading the location.
  await new Promise((r) => setTimeout(r, 3000));
  const { result } = await send(
    "Runtime.evaluate",
    { expression: "location.href", returnByValue: true },
    sessionId,
  );
  return { errorText: nav.errorText ?? "", finalUrl: result.value };
}

// 1. Extension service worker present? (Keep its target for DNR queries.)
let swSessionId;
{
  const { targetInfos } = await send("Target.getTargets");
  const sw = targetInfos.find(
    (t) =>
      t.type === "service_worker" &&
      t.url.includes("/dist/background/service-worker.js"),
  );
  report("extension service worker running", Boolean(sw), sw?.url ?? "not found");
  if (sw) {
    const attach = await send("Target.attachToTarget", {
      targetId: sw.targetId,
      flatten: true,
    });
    swSessionId = attach.sessionId;
  }
}

async function evalInWorker(expression) {
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    swSessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(r.result?.description ?? "evaluate threw");
  }
  return r.result?.value;
}

// 2. Blocklisted domain is blocked.
{
  const { errorText } = await navigate("https://pornhub.com/");
  report(
    "blocklisted domain is blocked",
    errorText.includes("ERR_BLOCKED_BY_CLIENT"),
    errorText || "navigation was not blocked",
  );
}

// 3. Unlisted origin is not blocked by us (over-blocking check). A local
// loopback server keeps this deterministic: no external network, no VPN or
// captive-portal interference — the check is about OUR rules, not the
// internet.
const localServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<title>sitr-smoke</title>ok");
});
await new Promise((r) => localServer.listen(0, "127.0.0.1", r));
{
  const { port } = localServer.address();
  const { errorText } = await navigate(`http://127.0.0.1:${port}/`);
  report(
    "unlisted origin is not blocked",
    !errorText.includes("ERR_BLOCKED_BY_CLIENT"),
    errorText,
  );
}
localServer.close();

// 4. All rulesets enabled, straight from the DNR engine.
if (swSessionId) {
  const enabled = await evalInWorker(
    "chrome.declarativeNetRequest.getEnabledRulesets()",
  );
  const want = ["sitr_adult", "sitr_gambling", "sitr_dating", "sitr_safesearch"];
  report(
    "all rulesets enabled",
    want.every((id) => enabled.includes(id)),
    enabled.join(", "),
  );

  // 5. SafeSearch rules match, per the engine's own matcher — deterministic,
  // no dependence on the search engines being reachable or bot-friendly.
  for (const [name, request, wantRuleId] of [
    ["google safesearch rule matches", { url: "https://www.google.com/search?q=x", type: "main_frame" }, 1001],
    ["bing safesearch rule matches", { url: "https://www.bing.com/search?q=x", type: "main_frame" }, 1002],
    ["duckduckgo safesearch rule matches", { url: "https://duckduckgo.com/?q=x", type: "main_frame" }, 1003],
    ["youtube restrict rule matches", { url: "https://www.youtube.com/watch?v=abc", type: "main_frame" }, 1004],
  ]) {
    const outcome = await evalInWorker(
      `chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify(request)})`,
    );
    const hit = outcome.matchedRules?.some(
      (m) => m.ruleId === wantRuleId && m.rulesetId === "sitr_safesearch",
    );
    report(name, Boolean(hit), JSON.stringify(outcome));
  }
}

// 6. Media filter (T12). Mode changes go through storage.local so this
// exercises the REAL path: storage change → worker refresh → preference
// re-assert → engine. Then the engine's own matcher checks the semantics.
if (swSessionId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const enabledEventually = async (id, wantEnabled) => {
    for (let i = 0; i < 20; i++) {
      const enabled = await evalInWorker(
        "chrome.declarativeNetRequest.getEnabledRulesets()",
      );
      if (enabled.includes(id) === wantEnabled) return true;
      await sleep(150);
    }
    return false;
  };
  const matchOutcome = (request) =>
    evalInWorker(
      `chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify(request)})`,
    );

  // Greylist mode: storage write alone must flip the engine.
  await evalInWorker(
    'chrome.storage.local.set({ mediaMode: "greylist" })',
  );
  report(
    "greylist mode: storage change enables the ruleset via re-assert",
    await enabledEventually("sitr_media_greylist", true),
    "sitr_media_greylist not enabled after mediaMode=greylist",
  );
  {
    const blocked = await matchOutcome({
      url: "https://i.redd.it/x.jpg",
      initiator: "https://www.reddit.com",
      type: "image",
    });
    report(
      "greylist blocks an image initiated from a greylisted site",
      blocked.matchedRules?.some(
        (m) => m.rulesetId === "sitr_media_greylist",
      ) ?? false,
      JSON.stringify(blocked),
    );
    const elsewhere = await matchOutcome({
      url: "https://example.com/x.jpg",
      initiator: "https://example.com",
      type: "image",
    });
    report(
      "greylist leaves images on other sites alone",
      !(elsewhere.matchedRules?.some(
        (m) => m.rulesetId === "sitr_media_greylist",
      ) ?? false),
      JSON.stringify(elsewhere),
    );
    const site = await matchOutcome({
      url: "https://www.reddit.com/",
      type: "main_frame",
    });
    report(
      "greylist never blocks the site itself",
      !(site.matchedRules?.some(
        (m) => m.rulesetId === "sitr_media_greylist",
      ) ?? false),
      JSON.stringify(site),
    );
  }

  // Allowlist-only mode: blanket block, image-allow band, category ceiling.
  await evalInWorker(
    'chrome.storage.local.set({ mediaMode: "allowlist" })',
  );
  report(
    "allowlist mode: re-assert swaps the enabled media ruleset",
    (await enabledEventually("sitr_media_all", true)) &&
      (await enabledEventually("sitr_media_greylist", false)),
    "expected sitr_media_all on and sitr_media_greylist off",
  );
  {
    const blocked = await matchOutcome({
      url: "https://example.com/x.jpg",
      initiator: "https://example.com",
      type: "image",
    });
    report(
      "allowlist mode blocks images everywhere by default",
      blocked.matchedRules?.some((m) => m.rulesetId === "sitr_media_all") ??
        false,
      JSON.stringify(blocked),
    );
    // Add an image-allow rule (the options page's band) and re-test.
    await evalInWorker(
      `chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{
        id: 4000000, priority: 2, action: { type: "allow" },
        condition: { initiatorDomains: ["example.com"],
                     resourceTypes: ["image", "media"] } }] })`,
    );
    const allowed = await matchOutcome({
      url: "https://cdn.example.net/x.jpg",
      initiator: "https://example.com",
      type: "image",
    });
    report(
      "image-allowlist entry restores images on that site",
      !(allowed.matchedRules?.some(
        (m) => m.rulesetId === "sitr_media_all",
      ) ?? false),
      JSON.stringify(allowed),
    );
    const category = await matchOutcome({
      url: "https://pornhub.com/x.jpg",
      initiator: "https://example.com",
      type: "image",
    });
    report(
      "category block still beats the image allowlist (priority ladder)",
      category.matchedRules?.some((m) => m.rulesetId === "sitr_adult") ??
        false,
      JSON.stringify(category),
    );
    await evalInWorker(
      "chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [4000000] })",
    );
  }

  // Back to off: both media rulesets must drop out.
  await evalInWorker('chrome.storage.local.remove("mediaMode")');
  report(
    "media off: re-assert disables both media rulesets",
    (await enabledEventually("sitr_media_all", false)) &&
      (await enabledEventually("sitr_media_greylist", false)),
    "media rulesets still enabled after mediaMode removed",
  );
}

ws.close();
const failed = results.filter((r) => !r.pass);
console.log(
  `\nsmoke: ${results.length - failed.length}/${results.length} passed` +
    (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
