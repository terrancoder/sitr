/**
 * Brand icon renderer — rasterizes the sitrshield.com logo mark (the
 * octagon / diamond / square construction with the gold four-point star
 * and the سِتْر wordmark) into every PNG the apps and extensions ship.
 *
 * The geometry and palette are lifted verbatim from the site's inline SVG
 * and its dark-theme tokens (paper #121a16, green #3aa886, gold #c9a558,
 * ink #e4ddc9, rule #2c3a32). Rendering uses a local headless Chromium
 * over CDP (same requirement as tests/smoke) because the wordmark needs a
 * real Arabic text shaper — no JS image library, keeping the
 * zero-runtime-dependency rule intact. Outputs are committed; re-running
 * is only needed when the mark changes. Size tiers keep the mark legible:
 *   >=128px  full mark (faint circles, all geometry, wordmark)
 *   32-127px no circles, thicker strokes, wordmark kept
 *   <32px    octagon + gold star only, boldest strokes
 *
 * Usage: node tools/icons/render-brand.mjs         (writes all targets)
 *        SITR_CHROME=/path/to/chrome overrides discovery.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

const COLORS = {
  paper: "#121a16",
  green: "#3aa886",
  gold: "#c9a558",
  ink: "#e4ddc9",
  rule: "#2c3a32",
};

/** The site's mark, parameterized by tier. Square 400-unit canvas. */
function markSvg({ circles, wordmark, stroke, star = "outline" }) {
  return `
  <svg viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    ${circles ? `<g stroke="${COLORS.rule}" stroke-width="${stroke.rule}">
      <circle cx="200" cy="200" r="196"/><circle cx="200" cy="200" r="158"/>
    </g>` : ""}
    <g stroke="${COLORS.green}" stroke-width="${stroke.green}" fill="none">
      <path d="M200 30 L320 80 L370 200 L320 320 L200 370 L80 320 L30 200 L80 80 Z"/>
      ${circles || wordmark ? `<path d="M200 30 L370 200 L200 370 L30 200 Z"/>
      <path d="M320 80 L320 320 L80 320 L80 80 Z"/>` : ""}
    </g>
    <path d="M200 96 L230 170 L304 200 L230 230 L200 304 L170 230 L96 200 L170 170 Z"
      ${star === "outline"
        ? `stroke="${COLORS.gold}" stroke-width="${stroke.gold}" fill="none"`
        : `fill="${COLORS.gold}"`}/>
    ${wordmark ? `<circle cx="200" cy="200" r="52" fill="${COLORS.paper}" stroke="${COLORS.rule}" stroke-width="${stroke.rule}"/>` : ""}
  </svg>`;
}

/**
 * One icon page. `shape`: "square" (full bleed, opaque — iOS, extension),
 * "mac" (Apple-style rounded tile at 80% of the canvas on transparency).
 */
function iconHtml(px, tier, shape) {
  const strokeFor = { large: { rule: 1, green: 2.5, gold: 2.5 },
                      medium: { rule: 2, green: 5, gold: 5 },
                      small: { rule: 0, green: 14, gold: 0 } }[tier];
  const svg = markSvg({
    circles: tier === "large",
    wordmark: tier !== "small",
    stroke: strokeFor,
    star: tier === "small" ? "fill" : "outline",
  });
  const tile = shape === "mac"
    ? `left:10%;top:10%;width:80%;height:80%;border-radius:18.5%;`
    : `inset:0;`;
  const word = tier === "small" ? "" :
    `<div style="position:absolute;left:0;right:0;top:50%;transform:translateY(-54%);
       text-align:center;color:${COLORS.ink};
       font-family:'Geeza Pro','Noto Naskh Arabic',serif;
       font-size:${(tier === "large" ? 0.155 : 0.175) * (shape === "mac" ? 0.8 : 1) * px}px;
       line-height:1;">سِتْر</div>`;
  return `<!doctype html><meta charset="utf-8">
  <style>html,body{margin:0;padding:0;background:transparent}</style>
  <body style="width:${px}px;height:${px}px;position:relative">
    <div style="position:absolute;${tile}background:${COLORS.paper};overflow:hidden">
      <div style="position:absolute;inset:4%">${svg}${word}</div>
    </div>
  </body>`;
}

/* ------------------------------- CDP driver ------------------------------- */

const home = homedir();
const CHROME_PATHS = [
  process.env.SITR_CHROME,
  join(home, ".cache/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  join(home, ".cache/chrome-for-testing/chrome-linux64/chrome"),
  "/usr/bin/chromium",
].filter(Boolean);
const chrome = CHROME_PATHS.find((p) => existsSync(p));
if (!chrome) {
  console.error("render-brand: no Chromium found — set SITR_CHROME (see tests/smoke)");
  process.exit(2);
}

const PORT = 9377;
const profile = mkdtempSync(join(tmpdir(), "sitr-icons-"));
const work = mkdtempSync(join(tmpdir(), "sitr-iconpages-"));
const proc = spawn(chrome, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--disable-background-networking",
  "--force-color-profile=srgb", "--hide-scrollbars",
], { stdio: "ignore" });
const cleanup = () => { try { proc.kill(); } catch {} rmSync(profile, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); };
process.on("exit", cleanup);

async function cdp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("chrome did not start");
}
const ws = new WebSocket(await cdp());
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`timeout: ${method}`)); }, 20000);
  });
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);

async function renderPng(px, tier, shape) {
  const page = join(work, `icon-${px}-${tier}-${shape}.html`);
  writeFileSync(page, iconHtml(px, tier, shape));
  await send("Emulation.setDeviceMetricsOverride",
    { width: px, height: px, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `file://${page}` }, sessionId);
  await new Promise((r) => setTimeout(r, 350));
  const shot = await send("Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false, fromSurface: true,
      clip: { x: 0, y: 0, width: px, height: px, scale: 1 } }, sessionId);
  return Buffer.from(shot.data, "base64");
}

const tierFor = (px) => (px >= 128 ? "large" : px >= 32 ? "medium" : "small");
async function emit(outPath, px, shape) {
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, await renderPng(px, tierFor(px), shape));
  console.log(`  ${outPath} (${px}px)`);
}

/* ------------------------------- targets ---------------------------------- */

console.log("extension icons:");
for (const px of [16, 32, 48, 128]) {
  await emit(join(ROOT, `extension/public/icon${px}.png`), px, "square");
}

console.log("macOS AppIcon:");
const macSet = join(ROOT, "apps/ios/SitrMac/Assets.xcassets/AppIcon.appiconset");
const macIcons = [
  ["icon_16.png", 16], ["icon_16@2x.png", 32], ["icon_32.png", 32],
  ["icon_32@2x.png", 64], ["icon_128.png", 128], ["icon_128@2x.png", 256],
  ["icon_256.png", 256], ["icon_256@2x.png", 512], ["icon_512.png", 512],
  ["icon_512@2x.png", 1024],
];
for (const [name, px] of macIcons) await emit(join(macSet, name), px, "mac");
writeFileSync(join(macSet, "Contents.json"), JSON.stringify({
  images: [16, 32, 128, 256, 512].flatMap((pt) => [
    { filename: `icon_${pt}.png`, idiom: "mac", scale: "1x", size: `${pt}x${pt}` },
    { filename: `icon_${pt}@2x.png`, idiom: "mac", scale: "2x", size: `${pt}x${pt}` },
  ]),
  info: { author: "xcode", version: 1 },
}, null, 2) + "\n");
writeFileSync(join(ROOT, "apps/ios/SitrMac/Assets.xcassets/Contents.json"),
  JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n");

console.log("iOS AppIcon (single-size, opaque):");
const iosSet = join(ROOT, "apps/ios/Sitr/Assets.xcassets/AppIcon.appiconset");
await emit(join(iosSet, "icon_1024.png"), 1024, "square");
writeFileSync(join(iosSet, "Contents.json"), JSON.stringify({
  images: [{ filename: "icon_1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
  info: { author: "xcode", version: 1 },
}, null, 2) + "\n");
writeFileSync(join(ROOT, "apps/ios/Sitr/Assets.xcassets/Contents.json"),
  JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n");

console.log("done");
ws.close();
cleanup();
process.exit(0);
