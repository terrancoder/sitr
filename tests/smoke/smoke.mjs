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
  // The worker starts only after Chrome has indexed the static rulesets, and
  // with ~100k domains that takes longer than the browser takes to open its
  // DevTools port, so poll instead of looking once.
  let sw;
  for (let i = 0; i < 100 && !sw; i++) {
    const { targetInfos } = await send("Target.getTargets");
    sw = targetInfos.find(
      (t) =>
        t.type === "service_worker" &&
        t.url.includes("/dist/background/service-worker.js"),
    );
    if (!sw) await new Promise((r) => setTimeout(r, 200));
  }
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

// 2b. A domain only in the imported adult tier (not curated) is blocked.
{
  const { errorText } = await navigate("https://007milf.com/");
  report(
    "imported-tier domain is blocked",
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

  // 4b. Every rule of every shipped block ruleset actually loaded: Chrome
  // skips an invalid static rule (or a ruleset over the static rule limit)
  // with no error the extension can see. Test the first domain of each
  // rule against the engine; the opt-in violence list is enabled briefly.
  {
    const { readFileSync } = await import("node:fs");
    const available = await evalInWorker(
      "chrome.declarativeNetRequest.getAvailableStaticRuleCount()",
    );
    report("static rule headroom left", available > 0, `available ${available}`);
    await evalInWorker(
      'chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["sitr_violence"] })',
    );
    for (const [rulesetId, file] of [
      ["sitr_adult", "adult.json"],
      ["sitr_gambling", "gambling.json"],
      ["sitr_dating", "dating.json"],
      ["sitr_violence", "violence.json"],
    ]) {
      const rules = JSON.parse(readFileSync(join(EXTENSION_DIR, "rulesets", file), "utf8"));
      const probes = rules.map((r) => ({ id: r.id, url: `https://${r.condition.requestDomains[0]}/`, type: "main_frame" }));
      const missed = await evalInWorker(`(async () => {
        const missed = [];
        for (const p of ${JSON.stringify(probes)}) {
          const o = await chrome.declarativeNetRequest.testMatchOutcome({ url: p.url, type: p.type });
          if (!o.matchedRules.some((m) => m.ruleId === p.id && m.rulesetId === "${rulesetId}")) missed.push(p.id);
        }
        return missed;
      })()`);
      report(`${rulesetId}: all ${rules.length} rules loaded`, missed.length === 0, missed.length ? `missing rule ids ${missed.join(", ")}` : "");
    }
    await evalInWorker(
      'chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ["sitr_violence"] })',
    );
  }

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

// 7. Options page: wait-before-loosening, the gated category toggle, the
// opt-in violence list and the report links — driven through the real page.
// The clock is stubbed in the PAGE context only (Date.now), no prod seam.
if (swSessionId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const extId = new URL(
    (await send("Target.getTargets")).targetInfos.find(
      (t) => t.type === "service_worker" && t.url.includes("/dist/background/service-worker.js"),
    ).url,
  ).host;
  await evalInWorker(
    'chrome.storage.local.set({ loosenDelayMinutes: 5 }).then(() => chrome.storage.local.remove(["loosenDelayRequest", "guardianPin", "disabledCategories"]))',
  );
  const opt = await send("Target.createTarget", {
    url: `chrome-extension://${extId}/src/options/options.html`,
  });
  const { sessionId: optSession } = await send("Target.attachToTarget", {
    targetId: opt.targetId,
    flatten: true,
  });
  const page = async (expression) => {
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      optSession,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page threw");
    return r.result?.value;
  };
  await sleep(1500);
  await page(`(() => { const real = Date.now.bind(Date); window.__off = 0;
    Date.now = () => real() + window.__off; })()`);
  const MIN = 60_000;
  const gambling = "document.querySelector('#category-list input')";
  const dialogText = "(document.querySelector('dialog')?.open ? document.querySelector('dialog p').textContent : null)";
  const pressDialog = (label) =>
    page(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
  const stored = (key) => page(`chrome.storage.local.get(${JSON.stringify(key)}).then((s) => s[${JSON.stringify(key)}] ?? null)`);
  const clickGambling = async () => { await page(`${gambling}.click()`); await sleep(400); };

  await clickGambling();
  const held = await page(dialogText);
  report(
    "delay on: turning Gambling off is held and the checkbox snaps back",
    /wait 5 minutes/.test(held ?? "") && (await page(`${gambling}.checked`)) === true &&
      !((await stored("disabledCategories")) ?? []).includes("sitr_gambling"),
    String(held),
  );
  await pressDialog("Start");
  await sleep(200);
  const request = await stored("loosenDelayRequest");
  await clickGambling();
  const waitingText = await page(dialogText);
  const waitingButtons = await page("[...document.querySelectorAll('dialog button')].filter((b) => !b.hidden).map((b) => b.textContent)");
  await pressDialog("Close");
  await sleep(200);
  const keptRequest = await stored("loosenDelayRequest");
  await page("document.getElementById('delay-cancel').click()");
  await sleep(200);
  report(
    "while waiting: held with 'Ready in', only 'Close' in the dialog; the request is cancelled in settings",
    /^Ready in 4:5\d|^Ready in 5:00/.test(waitingText ?? "") && JSON.stringify(waitingButtons) === '["Close"]' &&
      keptRequest !== null && (await stored("loosenDelayRequest")) === null &&
      (await page(`${gambling}.checked`)) === true,
    `${waitingText} | ${JSON.stringify(waitingButtons)}`,
  );
  await clickGambling();
  await pressDialog("Start");
  await sleep(200);
  await page(`window.__off = ${5 * MIN + 1000}`);
  await clickGambling();
  const opened = !(await page(dialogText)) &&
    (await page(`${gambling}.checked`)) === false &&
    ((await stored("disabledCategories")) ?? []).includes("sitr_gambling");
  report("inside the window the change goes through", Boolean(request) && opened, JSON.stringify(request));
  await clickGambling(); // back on: enableCategory, never held
  report("turning Gambling back on is free", (await page(`${gambling}.checked`)) === true);

  await page(`window.__off = ${15 * MIN + 1000}`);
  await clickGambling();
  report(
    "after the window closes the change is held again",
    /Start the wait/.test((await page(dialogText)) ?? "") && (await page(`${gambling}.checked`)) === true,
  );
  await pressDialog("Cancel");

  await page(`(() => { const s = document.getElementById('delay-minutes'); s.value = '0';
    s.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  report(
    "shortening the delay is itself held",
    /Start the wait/.test((await page(dialogText)) ?? "") && (await stored("loosenDelayMinutes")) === 5,
  );
  await pressDialog("Cancel");
  await sleep(300);
  report("delay select snaps back", (await page("document.getElementById('delay-minutes').value")) === "5");

  // Joining a household replaces this browser's settings by sync: held too.
  const pairing = await page(`import(chrome.runtime.getURL('dist/lib/sync/crypto.js')).then((m) => m.encodePairingCode(m.generateRootSecret()))`);
  await page(`document.getElementById('household-join-code').value = ${JSON.stringify(pairing)}`);
  await send(
    "Runtime.evaluate",
    { expression: "document.querySelector('#household-join-form button[type=submit]').click()", userGesture: true },
    optSession,
  );
  await sleep(500);
  const joinHeld = await page(dialogText);
  report(
    "join is held while the wait is on",
    /Start the wait/.test(joinHeld ?? "") && (await stored("householdSecret")) === null &&
      (await page("document.getElementById('household-none').hidden")) === false,
    String(joinHeld),
  );
  await pressDialog("Cancel");
  await sleep(200);

  // With a PIN: the hold first (no PIN asked), then inside the window the PIN.
  await page(`import(chrome.runtime.getURL('dist/lib/pin.js')).then(async (m) => {
    const r = await m.createPinRecord('1234'); await chrome.storage.local.set({ guardianPin: r.value }); })`);
  await page("window.__off = 0");
  await clickGambling();
  const firstHidden = await page("document.querySelector('dialog input').hidden");
  const first = await page(dialogText);
  await pressDialog("Start");
  await sleep(200);
  await page(`window.__off = ${5 * MIN + 1000}`);
  await clickGambling();
  const second = await page(dialogText);
  const secondIsPin = await page("document.querySelector('dialog input').type === 'password' && !document.querySelector('dialog input').hidden");
  await page("document.querySelector('dialog input').value = '1234'");
  await pressDialog("OK");
  await sleep(500);
  report(
    "with a PIN: wait ceremony first, then the PIN, then the change",
    /Start the wait/.test(first ?? "") && firstHidden === true &&
      /guardian PIN/.test(second ?? "") && secondIsPin === true &&
      ((await stored("disabledCategories")) ?? []).includes("sitr_gambling"),
    `${first} | ${second}`,
  );

  // Opt-in violence list: delay and PIN off first (straight to storage —
  // the gate has been exercised above).
  await evalInWorker(
    'chrome.storage.local.remove(["loosenDelayMinutes", "loosenDelayRequest", "guardianPin", "disabledCategories"])',
  );
  await page("window.__off = 0");
  const violenceDomain = "aaargh-international.org";
  const violenceHit = async () =>
    (await evalInWorker(
      `chrome.declarativeNetRequest.testMatchOutcome({ url: "https://${violenceDomain}/", type: "main_frame" })`,
    )).matchedRules?.some((m) => m.rulesetId === "sitr_violence") ?? false;
  const enabledNow = () => evalInWorker("chrome.declarativeNetRequest.getEnabledRulesets()");
  report("violence list off by default: not enabled, domain not matched",
    !(await enabledNow()).includes("sitr_violence") && !(await violenceHit()));
  await page("document.getElementById('optional-sitr_violence').click()");
  await sleep(1500);
  const { errorText: vErr } = await navigate(`https://${violenceDomain}/`);
  report(
    "violence switch on: ruleset enabled, domain blocked, status green",
    (await enabledNow()).includes("sitr_violence") && vErr.includes("ERR_BLOCKED_BY_CLIENT") &&
      (await evalInWorker("chrome.storage.local.get('protectionStatus').then((s) => s.protectionStatus.state)")) === "active",
    vErr,
  );
  await page("document.getElementById('optional-sitr_violence').click()");
  await sleep(1500);
  report(
    "violence switch off: ruleset disabled, domain not matched, status green",
    !(await enabledNow()).includes("sitr_violence") && !(await violenceHit()) &&
      (await evalInWorker("chrome.storage.local.get('protectionStatus').then((s) => s.protectionStatus.state)")) === "active",
  );

  const hrefs = await page("[...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))");
  report(
    "report links have the exact hrefs",
    [
      "https://github.com/terrancoder/sitr/issues/new?template=block-request.yml",
      "https://github.com/terrancoder/sitr/issues/new?template=unblock-request.yml",
      "mailto:support@sitrshield.com?subject=Site%20report",
    ].every((h) => hrefs.includes(h)) && !hrefs.includes("https://github.com/terrancoder/sitr/issues"),
    hrefs.join(" "),
  );
  report("options page shows no error", (await page("document.getElementById('error').textContent")) === "");
}

ws.close();
const failed = results.filter((r) => !r.pass);
console.log(
  `\nsmoke: ${results.length - failed.length}/${results.length} passed` +
    (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
