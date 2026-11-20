/**
 * Real-browser check of the options page's Sitr Family code, against the
 * local development servers (tests/dist/devClaimServer.js): enter a
 * subscription code, create a household with it, see "Covered until", and
 * remove the code. Zero dependencies, like smoke.mjs (DevTools protocol
 * over Node's WebSocket); needs `openssl` for a throwaway certificate.
 *
 * The extension is NOT changed to reach the local servers: the browser's
 * own resolver maps sync.sitrshield.com and claim.sitrshield.com to a local
 * TLS proxy in front of the dev servers, and every other name to nothing
 * (`MAP * ~NOTFOUND`), so no request can reach a real host. A canary name
 * must reach the proxy before anything else runs, or the script stops.
 *
 * The permission prompt for the claim host cannot be clicked from here: the
 * page's chrome.permissions.request is replaced by one that says yes. So
 * the background never claims (claimAllowed() is false); the page's own
 * creation claim and the worker's creating write carry the flow.
 *
 *   npm run build:extension && npm run build:server && npx tsc -p tests/tsconfig.json
 *   SITR_CHROME="$BRAVE_PATH" node tests/smoke/family.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const BROWSER = process.env.SITR_CHROME ?? process.env.BRAVE_PATH;
if (!BROWSER) {
  console.error("FAMILY: set SITR_CHROME (or BRAVE_PATH) to a Chromium-based browser");
  process.exit(2);
}
const CODE = "6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b";
const PORT = 9335;
const work = mkdtempSync(join(tmpdir(), "sitr-family-"));
const children = [];
process.on("exit", () => {
  for (const c of children) c.kill();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.error(`FAMILY: temp folder left behind at ${work}`);
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. The dev servers, with a stub subscription that runs a month ahead.
const end = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
const dev = spawn(
  process.execPath,
  ["--experimental-sqlite", "--no-warnings=ExperimentalWarning", join(ROOT, "tests/dist/devClaimServer.js")],
  {
    env: { ...process.env, SITR_DEV_POLAR_SUBS: `${CODE}=active:month:${end}`, SITR_DEV_SYNC_PORT: "0", SITR_DEV_CLAIM_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
children.push(dev);
const bases = await new Promise((res, rej) => {
  let out = "";
  dev.stdout.on("data", (d) => {
    out += d;
    const sync = /dev sync server\s+(http:\S+)/.exec(out)?.[1];
    const claim = /dev claim server\s+(http:\S+)/.exec(out)?.[1];
    if (sync && claim) res({ "sync.sitrshield.com": sync, "claim.sitrshield.com": claim });
  });
  dev.on("exit", (c) => rej(new Error(`dev server exited ${c}`)));
});

// 2. A TLS proxy for both names, with a throwaway self-signed certificate.
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=sitr-dev",
  "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"),
], { stdio: "ignore" });
const hits = [];
const proxy = createServer(
  { key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) },
  (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    hits.push(`${req.method} ${host}${req.url}`);
    if (host === "canary.invalid") return void res.writeHead(200, { "access-control-allow-origin": "*" }).end("canary");
    const base = bases[host];
    if (!base) return void res.writeHead(421).end();
    const up = httpRequest(new URL(req.url, base), { method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  },
);
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const pp = proxy.address().port;

// 3. The browser, its resolver pointed at the proxy and nowhere else.
const profile = join(work, "profile");
children.push(
  spawn(BROWSER, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${join(ROOT, "extension")}`,
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    `--host-resolver-rules=MAP sync.sitrshield.com 127.0.0.1:${pp}, MAP claim.sitrshield.com 127.0.0.1:${pp}, ` +
      `MAP canary.invalid 127.0.0.1:${pp}, MAP * ~NOTFOUND`,
    "--ignore-certificate-errors",
  ], { stdio: "ignore" }),
);

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    await sleep(200);
  }
}
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error("websocket failed")))));
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => pending.delete(id) && rej(new Error(`timeout: ${method}`)), 15_000);
  });

const results = [];
const report = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
};

let sw;
for (let i = 0; i < 100 && !sw; i++) {
  sw = (await send("Target.getTargets")).targetInfos.find(
    (t) => t.type === "service_worker" && t.url.includes("/dist/background/service-worker.js"),
  );
  if (!sw) await sleep(200);
}
const extId = new URL(sw.url).host;
const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/options/options.html` });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const page = async (expression, userGesture = false) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (r.exceptionDetails) throw new Error(r.result?.description ?? "evaluate threw");
  return r.result?.value;
};
const stored = (key) => page(`chrome.storage.local.get(${JSON.stringify(key)}).then((s) => s[${JSON.stringify(key)}] ?? null)`);
const until = async (expression, ms = 20_000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await page(expression)) return true;
    await sleep(250);
  }
  return false;
};
const pressDialog = (label) =>
  page(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

// The page is wired once its last section has rendered.
await until("document.querySelectorAll('#category-list li').length > 0", 15_000);
// 4. Fail closed: the canary reaches the proxy, a real name reaches nothing.
const canary = await page("fetch('https://canary.invalid/').then((r) => r.text()).catch((e) => 'ERR ' + e)");
const real = await page("fetch('https://example.com/').then(() => 'reached').catch(() => 'blocked')");
report("resolver: canary reaches the local proxy, real names resolve to nothing", canary === "canary" && real === "blocked", `${canary} / ${real}`);
if (canary !== "canary" || real !== "blocked") process.exit(1);

// 5. Enter the code and create the household.
// The prompt cannot be clicked here: answer yes in this page only.
await page("Object.defineProperty(chrome.permissions, 'request', { value: async () => true, configurable: true })");
report("the page's permission request is answered", (await page("chrome.permissions.request({ origins: [] })")) === true);
report(
  "the Family section is shown with a labelled code input",
  (await page("!document.getElementById('full-channel-only').hidden && document.querySelector('label[for=family-code]')?.textContent")) === "Subscription code",
);
await page(`document.getElementById('family-code').value = ${JSON.stringify(CODE)}`);
await page("document.getElementById('family-code-submit').click()", true);
const pinAsked = await until("document.querySelector('dialog')?.open && /guardian PIN/.test(document.querySelector('dialog p').textContent)", 10_000);
if (pinAsked) await pressDialog("Cancel");
report(
  "creating with the code: claimed on the claim host, household created, PIN offered",
  pinAsked && hits.includes("POST claim.sitrshield.com/v1/entitlement/claim") &&
    (await stored("subscriptionCode")) === CODE && (await stored("householdRole")) === "guardian",
  `${await page("document.getElementById('error').textContent")} | ${hits.join(", ")}`,
);
const covered = await until("/Covered until/.test(document.getElementById('household-end').textContent)");
report(
  "the worker's creating write carries the token; the page shows \"Covered until\"",
  covered && hits.some((h) => h.startsWith("PUT sync.sitrshield.com/v1/blob/")),
  await page("document.getElementById('household-end').textContent"),
);
report(
  "guardian controls: Save code, Remove code; no rebind offered",
  (await page("document.getElementById('family-code-submit').textContent")) === "Save code" &&
    (await page("!document.getElementById('family-remove').hidden && document.getElementById('family-replace').hidden")) === true,
);

// 6. Remove the code.
await page("document.getElementById('family-remove').click()", true);
await until("document.querySelector('dialog')?.open", 5_000);
const question = await page("document.querySelector('dialog p').textContent");
await pressDialog("Remove code");
const removed = await until("/no longer renews/.test(document.getElementById('family-status').textContent)", 5_000);
report(
  "Remove code: asked, then code and claim secret gone; the household runs on",
  /Renewals stop on this browser/.test(question) && removed &&
    (await stored("subscriptionCode")) === null && (await stored("claimSecret")) === null &&
    (await stored("householdSecret")) !== null,
  await page("document.getElementById('family-status').textContent"),
);
// 7. Enter it again as a guardian: stored, and the page's alarm wakes a round.
const before = hits.length;
await page(`document.getElementById('family-code').value = ${JSON.stringify(CODE)}`);
await page("document.getElementById('family-code-submit').click()", true);
const saved = await until("document.getElementById('family-status').textContent === 'This browser renews the Family plan.'", 5_000);
let woke = false;
for (let t = 0; t < 45_000 && !woke; t += 500) {
  woke = hits.slice(before).some((h) => h.startsWith("GET sync.sitrshield.com/v1/blob/"));
  if (!woke) await sleep(500);
}
report(
  "Save code in the household: stored, and a sync round follows (the page's alarm)",
  saved && woke && (await stored("subscriptionCode")) === CODE,
  hits.slice(before).join(", "),
);
report("options page shows no error", (await page("document.getElementById('error').textContent")) === "");

ws.close();
const failed = results.filter((p) => !p).length;
console.log(`\nfamily: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
