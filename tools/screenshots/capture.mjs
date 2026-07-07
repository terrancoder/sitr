/**
 * Store-asset capture: loads the built extension in a Chromium that honors
 * --load-extension and screenshots real UI (popup, options, YouTube
 * Restricted Mode proof) at the Chrome Web Store's 1280x800, plus renders
 * the 440x280 promo tile from an HTML template. Zero dependencies.
 *
 * Usage: npm run build && node tools/screenshots/capture.mjs
 * Output: extension/store-listing/assets/
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "extension/store-listing/assets");
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const chrome = [
  process.env.SITR_CHROME,
  join(home, ".cache/chrome-for-testing/chrome-win64/chrome.exe"),
  join(home, ".cache/chrome-for-testing/chrome-linux64/chrome"),
].filter(Boolean).find((p) => existsSync(p));
if (!chrome) {
  console.error("capture: no Chrome for Testing found (see README smoke-test note)");
  process.exit(2);
}

const PORT = 9338;
const proc = spawn(
  chrome,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "sitr-shots-"))}`,
    `--load-extension=${join(ROOT, "extension")}`,
    "--headless=new",
    "--no-first-run",
    "--lang=en",
    "--force-device-scale-factor=1",
  ],
  { stdio: "ignore" },
);
process.on("exit", () => proc.kill());

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())
      .webSocketDebuggerUrl;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (!wsUrl) {
  console.error("capture: browser did not start");
  process.exit(1);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("websocket failed"));
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
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
    setTimeout(() => pending.delete(id) && rej(new Error(`timeout: ${method}`)), 20_000);
  });

await new Promise((r) => setTimeout(r, 2500));
const { targetInfos } = await send("Target.getTargets");
const sw = targetInfos.find(
  (t) =>
    t.type === "service_worker" &&
    t.url.includes("/dist/background/service-worker.js"),
);
if (!sw) {
  console.error("capture: extension not loaded");
  process.exit(1);
}
const extId = new URL(sw.url).host;

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);

mkdirSync(OUT, { recursive: true });

async function shoot(name, url, { width, height, scale = 1, settle = 2500 }) {
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: scale, mobile: false },
    sessionId,
  );
  await send("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, settle));
  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(OUT, name), Buffer.from(shot.data, "base64"));
  console.log(`wrote ${name}`);
}

// Store screenshots must be 1280x800. UI pages are small, so render them at
// 640x400 with 2x scale for a crisp result.
await shoot("screenshot-1-popup.png", `chrome-extension://${extId}/src/popup/popup.html`, {
  width: 640, height: 400, scale: 2,
});
await shoot("screenshot-2-options.png", `chrome-extension://${extId}/src/options/options.html`, {
  width: 640, height: 400, scale: 2,
});
await shoot(
  "screenshot-3-youtube-restricted.png",
  "https://www.youtube.com/results?search_query=lingerie+haul",
  { width: 1280, height: 800, settle: 8000 },
);
await shoot("screenshot-4-blocked.png", "https://pornhub.com/", {
  width: 1280, height: 800,
});

// Promo tile (440x280) from a local HTML template.
await shoot(
  "promo-tile-440x280.png",
  pathToFileURL(join(ROOT, "tools/screenshots/promo-tile.html")).href,
  { width: 440, height: 280, settle: 800 },
);

ws.close();
console.log(`assets -> ${OUT}`);
process.exit(0);
