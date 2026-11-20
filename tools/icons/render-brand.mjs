/**
 * Brand renderer for the Sitr logo: the shield emblem alone. Everything is
 * built from the logo the owner supplied (made with Canva; embedded metadata
 * removed, image data unchanged) in brand-kit/source/ (the 1264 px "without
 * background" PNG is the master; the words under its emblem are not used, by
 * the owner's decision of 2026-11-19) plus the small mark, our solid-facet
 * version traced from the master for 48 px and below.
 *
 * Rules the code enforces:
 *   - The owner's raster is the logo wherever the emblem is drawn taller than
 *     SMALL_MAX px; at or below that the small mark is drawn instead.
 *   - The emblem is never scaled above MAX_UPSCALE of its native size.
 *   - Icons sit on white. For dark grounds the master is recoloured (deep
 *     green -> #3aa886, gold -> #c9a558).
 *   - The master is cleaned by unmixing it against white ("colour to alpha"):
 *     identical on white, and the pale specks and light fringes left by the
 *     background removal fall away on other grounds.
 *
 * Outputs: brand-kit/{logo,web,social}/, brand-kit/preview.{html,png}, the iOS
 * and macOS AppIcon PNGs, extension/public/icon{16,32,48,128}.png, the Android
 * adaptive-icon layers, the Play icon and feature graphic, and the Chrome Web
 * Store promo tile (rendered from tools/screenshots/promo-tile.html, the same
 * template capture.mjs uses). Pixel work runs in headless Brave/Chromium over
 * CDP (canvas); PNGs are encoded here with zlib so opaque files carry no alpha.
 * No dependencies. Output is deterministic for a given browser build.
 *
 * Usage: node tools/icons/render-brand.mjs                 (everything)
 *        node tools/icons/render-brand.mjs masters social  (only those steps:
 *          masters, icons, web, store, social, preview; later steps read the
 *          files earlier ones write)
 *        Browser: SITR_CHROME, else BRAVE_PATH, else the standard Brave path,
 *        else the Chrome-for-Testing cache.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "../..");
const KIT = join(ROOT, "brand-kit");
const MASTER = join(KIT, "source/Sitr Shield Logo without background.png");

// ---------------------------------------------------------------- parameters

/** The emblem's ink box inside the 1264 px master (the rows below it are not used). */
const EMBLEM_BOX = { x: 232, y: 73, w: 801, h: 862 };
const SMALL_MAX = 48; // emblem drawn this tall or less -> small mark
const MAX_UPSCALE = 1.1;

const C = {
  white: "#ffffff",
  green: "#1d573b", gold: "#c69842", // master inks (medians), small mark fills
  darkGround: "#121a16", darkGreen: "#3aa886", darkGold: "#c9a558", cream: "#e4ddc9",
  paper: "#f4efe4", ink: "#1d2a24", inkSoft: "#51604f", inkSoftDark: "#94a093",
};

/**
 * Small mark: solid facets traced from the master's silhouette and colour
 * layout (1264 px, smoothed), in emblem-box pixels. Green: the top-left facet
 * and the U of the right and lower-left bands. Gold: the top face, the left
 * strip and the inner gold edge. SILHOUETTE (outline + centre hole) is the
 * Android monochrome layer.
 */
const SMALL = {
  green: "M130 375 105 375 89 369 74 356 60 335 24 262 8 245 0 239 0 193 6 178 27 165 67 147 194 105 251 83 328 47 397 1 403 1 409 5 404 53 372 122 312 212 262 266 240 299 228 330 215 343 201 351 170 365ZM400 861 375 853 335 833 269 793 218 755 154 694 108 639 74 586 52 540 36 493 62 454 86 431 113 419 131 425 166 457 194 505 332 639 368 687 414 735 426 745 435 745 440 740 442 730 450 727 454 722 490 640 512 577 532 498 544 432 550 361 548 281 544 246 538 237 548 229 580 213 608 179 663 147 683 143 720 145 784 171 798 184 800 224 798 304 792 366 782 419 768 472 750 523 722 582 692 630 662 668 626 708 577 753 536 785 489 817 450 839Z",
  gold: "M435 745 426 745 416 737 368 687 332 639 194 505 166 457 131 425 113 419 86 431 62 454 34 494 20 439 12 397 4 335 0 274 0 239 8 245 24 262 56 330 68 347 86 367 93 371 105 375 138 375 170 365 209 347 228 330 240 299 262 266 312 212 372 122 404 53 410 7 469 45 534 79 608 109 718 144 683 143 653 151 608 179 580 213 548 229 539 237 527 237 422 289 243 361 201 379 196 385 192 422 194 455 204 507 442 729 440 740Z",
  silhouette: "M400 861 375 853 324 827 275 797 232 767 194 735 154 694 102 629 74 586 56 549 30 481 20 439 10 384 0 274 0 193 4 181 12 173 67 147 194 105 265 77 342 39 397 1 403 1 446 31 487 55 543 83 625 115 741 151 784 171 798 184 800 224 800 288 796 336 778 432 750 523 722 582 704 612 678 648 642 691 603 731 565 763 489 817 450 839ZM446 729 452 725 462 705 500 610 524 535 542 452 550 382 550 312 544 246 542 239 536 235 527 237 469 267 392 301 213 373 201 379 196 389 192 422 194 455 204 507 352 645 430 721 438 727Z",
};

/** Icon layouts: emblem height as a fraction of the icon (or tile). */
const ICON = {
  app: 0.72, // iOS, Play, apple-touch, PWA: white square, emblem centred
  macTile: { inset: 100 / 1024, radius: 185 / 824, emblem: 0.7 }, // Apple grid
  tile: { radius: 0.22, emblem: 0.8 }, // extension and favicon: white rounded tile
  android: { canvas: 108, emblem: 56 }, // dp; fits the 66 dp safe circle
};

// ------------------------------------------------------------ small helpers

const f1 = (v) => (Math.round(v * 10) / 10).toString();
const rel = (from, to) => relative(dirname(from), to).split("\\").join("/");
const ensure = (p) => mkdirSync(dirname(p), { recursive: true });
const written = [];
function out(path, data) {
  ensure(path);
  writeFileSync(path, data);
  written.push(path);
  console.log(`  ${relative(ROOT, path)} (${(data.length / 1024).toFixed(1)} KB)`);
}

/** Small-mark path data, scaled from emblem pixels by `s` and offset. */
function scalePath(d, s, x0, y0) {
  return d.split("Z").filter(Boolean).map((sub) => {
    const n = sub.replace("M", "").trim().split(/\s+/).map(Number);
    const pts = [];
    for (let i = 0; i < n.length; i += 2) pts.push(`${f1(x0 + n[i] * s)} ${f1(y0 + n[i + 1] * s)}`);
    return `M${pts.join(" ")}Z`;
  }).join("");
}

/** The small mark as an SVG body inside a box of `size`, emblem `h` tall. */
function smallSvgBody(size, h, colors, tile) {
  const s = h / EMBLEM_BOX.h, x0 = (size - EMBLEM_BOX.w * s) / 2, y0 = (size - h) / 2;
  const bg = tile ? `<rect width="${size}" height="${size}" rx="${f1(size * ICON.tile.radius)}" fill="${C.white}"/>` : "";
  return `${bg}<path fill="${colors.green}" d="${scalePath(SMALL.green, s, x0, y0)}"/><path fill="${colors.gold}" d="${scalePath(SMALL.gold, s, x0, y0)}"/>`;
}
const smallSvg = (size, h, colors, tile = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${smallSvgBody(size, h, colors, tile)}</svg>\n`;

// ------------------------------------------------------------- PNG and ICO

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA pixels -> PNG; RGB (no alpha channel) unless `alpha`. */
function encodePng(w, h, rgba, alpha) {
  const ch = alpha ? 4 : 3, raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (w * ch + 1) + 1 + x * ch;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
/** ICO with PNG-compressed entries (Vista+ and every current browser). */
function encodeIco(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head[e] = size % 256; head[e + 1] = size % 256; head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

// ---------------------------------------------------------------- browser

const BROWSER = [process.env.SITR_CHROME, process.env.BRAVE_PATH,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  join(homedir(), ".cache/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  join(homedir(), ".cache/chrome-for-testing/chrome-linux64/chrome"),
].find((p) => p && existsSync(p));

async function openBrowser() {
  if (!BROWSER) { console.error("render-brand: no Chromium found, set SITR_CHROME or BRAVE_PATH"); process.exit(2); }
  const work = mkdtempSync(join(tmpdir(), "sitr-brand-"));
  const PORT = 9377;
  const proc = spawn(BROWSER, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, "profile")}`,
    "--headless=new", "--no-first-run", "--disable-background-networking", "--disable-crash-reporter",
    "--force-color-profile=srgb", "--hide-scrollbars", "--allow-file-access-from-files", "about:blank"], { stdio: "ignore" });
  const exited = new Promise((r) => proc.on("exit", r));
  const close = () => { try { proc.kill(); } catch {} rmSync(work, { recursive: true, force: true, maxRetries: 10 }); };
  process.on("exit", close);
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!wsUrl) throw new Error("browser did not start");
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`timeout: ${method}`)); }, 120000);
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const navigate = async (url, w, h) => {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send("Page.navigate", { url }, sessionId);
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.readyState === 'complete' && [...document.images].every((i) => i.complete)")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await evaluate("document.fonts.ready.then(() => true)");
  };
  const shot = async (w, h) => {
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }, sessionId);
    return Buffer.from(r.data, "base64");
  };
  return { work, evaluate, navigate, shot, close: async () => { ws.close(); close(); await exited; } };
}

/**
 * In-page library (canvas). S.init() builds the cleaned light emblem and the
 * dark recolour from the master; S.draw() composes an icon from
 * ops and returns RGBA; S.inject() swaps <img data-emblem> for resampled art.
 */
const PAGE_LIB = String.raw`
window.S = (() => {
  const P = __PARAMS__;
  const canvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const art = {};
  async function init(src) {
    const img = new Image(); img.src = src; await img.decode();
    const W = img.width, H = img.height;
    const white = canvas(W, H), wx = white.getContext("2d");
    wx.fillStyle = "#fff"; wx.fillRect(0, 0, W, H); wx.drawImage(img, 0, 0);
    const px = wx.getImageData(0, 0, W, H).data;
    const light = new ImageData(W, H), dark = new ImageData(W, H);
    const gRef = hex(P.green), oRef = hex(P.gold), gT = hex(P.darkGreen), oT = hex(P.darkGold);
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      // colour to alpha against white
      let a = Math.max(255 - r, 255 - g, 255 - b) / 255;
      if (a < 0.04) continue; // pale specks and haze
      const u = [255 - (255 - r) / a, 255 - (255 - g) / a, 255 - (255 - b) / a];
      light.data.set([u[0], u[1], u[2], a * 255], i);
      // dark recolour: green/gold weight from the ink's hue, shading kept at half strength
      const t = Math.min(1, Math.max(0, (u[0] - u[1] + 40) / 80));
      const o = [0, 1, 2].map((k) => gT[k] + (oT[k] - gT[k]) * t + 0.5 * (u[k] - (gRef[k] + (oRef[k] - gRef[k]) * t)));
      dark.data.set([o[0], o[1], o[2], a * 255], i);
    }
    for (const [name, data] of [["light", light], ["dark", dark]]) {
      const c = canvas(W, H); c.getContext("2d").putImageData(data, 0, 0);
      const crop = (b) => { const k = canvas(b.w, b.h); k.getContext("2d").drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h); return k; };
      art[name] = crop(P.emblem);
    }
    return true;
  }
  /** Draw source canvas into ctx at (x,y,w,h), halving first so the filter never skips pixels. */
  function resample(ctx, src, x, y, w, h) {
    let cur = src;
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      const n = canvas(Math.round(cur.width / 2), Math.round(cur.height / 2)), nx = n.getContext("2d");
      nx.imageSmoothingQuality = "high"; nx.drawImage(cur, 0, 0, n.width, n.height); cur = n;
    }
    ctx.imageSmoothingQuality = "high"; ctx.drawImage(cur, x, y, w, h);
  }
  function smallMark(ctx, variant, cx, cy, h) {
    const s = h / P.emblem.h, w = P.emblem.w * s;
    ctx.save(); ctx.translate(cx - w / 2, cy - h / 2); ctx.scale(s, s);
    ctx.fillStyle = variant === "dark" ? P.darkGreen : P.green; ctx.fill(new Path2D(P.small.green));
    ctx.fillStyle = variant === "dark" ? P.darkGold : P.gold; ctx.fill(new Path2D(P.small.gold));
    ctx.restore();
  }
  /** Emblem centred on (cx,cy), h px tall; small mark at or below SMALL_MAX unless forced. */
  function emblem(ctx, variant, cx, cy, h, force) {
    if (h > P.emblem.h * P.maxUp) throw new Error("emblem upscaled beyond limit: " + h);
    if (force === "small" || (force !== "raster" && h <= P.smallMax)) return smallMark(ctx, variant, cx, cy, h);
    const w = h * P.emblem.w / P.emblem.h;
    resample(ctx, art[variant], cx - w / 2, cy - h / 2, w, h);
  }
  function rrect(ctx, x, y, w, h, r, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
  }
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  /** ops: [kind, ...args]; returns {w, h, rgba(base64)} */
  function draw(w, h, ops) {
    const c = canvas(w, h), ctx = c.getContext("2d");
    for (const [k, ...a] of ops) {
      if (k === "fill") { ctx.fillStyle = a[0]; ctx.fillRect(0, 0, w, h); }
      else if (k === "rrect") rrect(ctx, ...a);
      else if (k === "emblem") emblem(ctx, ...a);
    }
    return { w, h, rgba: b64(new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer)), canvas: c };
  }
  function webp(w, h, ops, q) { return draw(w, h, ops).canvas.toDataURL("image/webp", q).split(",")[1]; }
  function dataUrl(w, h, ops) { return draw(w, h, ops).canvas.toDataURL("image/png"); }
  /** Replace <img data-emblem="light|dark"> with the emblem resampled to its box. */
  async function inject() {
    for (const img of document.querySelectorAll("img[data-emblem]")) {
      const r = img.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
      img.src = dataUrl(w, h, [["emblem", img.dataset.emblem, w / 2, h / 2, h]]);
      await img.decode();
    }
    return true;
  }
  return { init, draw: (w, h, ops) => { const r = draw(w, h, ops); delete r.canvas; return r; }, webp, dataUrl, inject };
})();
`;

const PAGE_PARAMS = {
  emblem: EMBLEM_BOX, smallMax: SMALL_MAX, maxUp: MAX_UPSCALE,
  small: SMALL, green: C.green, gold: C.gold, darkGreen: C.darkGreen, darkGold: C.darkGold,
};
/** Load the canvas library and the master into the current page. */
async function loadLib(b) {
  await b.evaluate(PAGE_LIB.replace("__PARAMS__", JSON.stringify(PAGE_PARAMS)));
  await b.evaluate(`S.init(${JSON.stringify(`data:image/png;base64,${readFileSync(MASTER).toString("base64")}`)})`);
}

/** Render ops in the page and write a PNG (RGB unless alpha). */
async function png(b, path, w, h, ops, alpha) {
  const r = await b.evaluate(`S.draw(${w}, ${h}, ${JSON.stringify(ops)})`);
  const data = encodePng(w, h, Buffer.from(r.rgba, "base64"), alpha);
  if (path) out(path, data);
  return data;
}

/** Load an HTML file, swap in resampled emblems, screenshot it. */
async function renderHtml(b, htmlPath, outPath, w, h) {
  await b.navigate(pathToFileURL(htmlPath).href, w, h);
  await loadLib(b);
  await b.evaluate("S.inject()");
  out(outPath, await b.shot(w, h));
}

// ------------------------------------------------------------------ layouts

const appIcon = (size, variant = "light") => [["fill", C.white], ["emblem", variant, size / 2, size / 2, size * ICON.app]];
const tileIcon = (size) => [["rrect", 0, 0, size, size, size * ICON.tile.radius, C.white],
  ["emblem", "light", size / 2, size / 2, size * ICON.tile.emblem]];
function macIcon(size) {
  const t = ICON.macTile, x = size * t.inset, w = size - 2 * x;
  return [["rrect", x, x, w, w, w * t.radius, C.white], ["emblem", "light", size / 2, size / 2, w * t.emblem]];
}
// ------------------------------------------------------------------- targets

async function buildMasters(b) {
  console.log("brand-kit/logo:");
  const L = join(KIT, "logo");
  const E = EMBLEM_BOX, m = Math.round(E.h * 0.04);
  for (const v of ["light", "dark"]) {
    const sfx = v === "dark" ? "-dark" : "";
    await png(b, join(L, `sitr-shield-emblem${sfx}.png`), E.w + 2 * m, E.h + 2 * m, [["emblem", v, E.w / 2 + m, E.h / 2 + m, E.h, "raster"]], true);
  }
  const sm = { green: C.green, gold: C.gold }, smd = { green: C.darkGreen, gold: C.darkGold };
  out(join(L, "sitr-shield-small.svg"), smallSvg(100, 92, sm));
  out(join(L, "sitr-shield-small-dark.svg"), smallSvg(100, 92, smd));
  for (const px of [16, 24, 32, 48]) await png(b, join(L, `sitr-shield-small-${px}.png`), px, px, [["emblem", "light", px / 2, px / 2, px * 0.92, "small"]], true);
}

async function buildIcons(b) {
  console.log("iOS AppIcon (opaque):");
  const ios = await png(b, join(ROOT, "apps/ios/Sitr/Assets.xcassets/AppIcon.appiconset/icon_1024.png"), 1024, 1024, appIcon(1024), false);
  out(join(KIT, "logo/sitr-shield-app-icon-1024.png"), ios);

  console.log("macOS AppIcon (rounded tile, transparent margin):");
  const mac = join(ROOT, "apps/ios/SitrMac/Assets.xcassets/AppIcon.appiconset");
  for (const [name, px] of [["icon_16", 16], ["icon_16@2x", 32], ["icon_32", 32], ["icon_32@2x", 64],
    ["icon_128", 128], ["icon_128@2x", 256], ["icon_256", 256], ["icon_256@2x", 512], ["icon_512", 512], ["icon_512@2x", 1024]]) {
    await png(b, join(mac, `${name}.png`), px, px, macIcon(px), true);
  }

  console.log("extension icons (white rounded tile):");
  for (const px of [16, 32, 48, 128]) await png(b, join(ROOT, `extension/public/icon${px}.png`), px, px, tileIcon(px), true);

  console.log("Android adaptive icon:");
  const res = join(ROOT, "apps/android/app/src/main/res"), A = ICON.android;
  for (const [dpi, k] of [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]]) {
    const px = A.canvas * k;
    await png(b, join(res, `mipmap-${dpi}/ic_launcher_foreground.png`), px, px, [["emblem", "light", px / 2, px / 2, A.emblem * k, "raster"]], true);
  }
  const s = A.emblem / EMBLEM_BOX.h, x0 = (A.canvas - EMBLEM_BOX.w * s) / 2, y0 = (A.canvas - A.emblem) / 2;
  out(join(res, "drawable/ic_launcher_monochrome.xml"), `<?xml version="1.0" encoding="utf-8"?>
<!-- Themed-icon layer (Android 13+): the Sitr logo's silhouette with its open
     centre, one colour (the launcher tints it). Generated by
     tools/icons/render-brand.mjs from the small mark; do not edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFFFF"
        android:fillType="evenOdd"
        android:pathData="${scalePath(SMALL.silhouette, s, x0, y0)}" />
</vector>
`);
  out(join(res, "mipmap-anydpi-v26/ic_launcher.xml"), `<?xml version="1.0" encoding="utf-8"?>
<!-- Sitr launcher icon: the shield emblem (raster per density, fine
     line work a vector cannot carry) on white; separate monochrome layer for
     themed icons. Generated by tools/icons/render-brand.mjs. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/launcher_bg" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`);
  out(join(res, "values/colors.xml"), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Adaptive-icon background: the Sitr logo (shield emblem) is drawn for white. -->
    <color name="launcher_bg">#FFFFFF</color>
</resources>
`);
  rmSync(join(res, "drawable/ic_launcher_foreground.xml"), { force: true });
}

async function buildWeb(b) {
  console.log("brand-kit/web:");
  const Wd = join(KIT, "web");
  const ico = [];
  for (const px of [16, 32, 48]) ico.push({ size: px, png: await png(b, null, px, px, tileIcon(px), true) });
  out(join(Wd, "favicon.ico"), encodeIco(ico));
  out(join(Wd, "favicon.svg"), smallSvg(32, 32 * ICON.tile.emblem, { green: C.green, gold: C.gold }, true));
  await png(b, join(Wd, "apple-touch-icon.png"), 180, 180, appIcon(180), false);
  await png(b, join(Wd, "icon-192.png"), 192, 192, appIcon(192), false);
  await png(b, join(Wd, "icon-512.png"), 512, 512, appIcon(512), false);
  for (const [w, sfx] of [[360, ""], [720, "@2x"]]) {
    const h = Math.round(w * EMBLEM_BOX.h / EMBLEM_BOX.w);
    const ops = [["emblem", "light", w / 2, h / 2, h, "raster"]];
    await png(b, join(Wd, `sitr-shield-hero${sfx}.png`), w, h, ops, true);
    out(join(Wd, `sitr-shield-hero${sfx}.webp`), Buffer.from(await b.evaluate(`S.webp(${w}, ${h}, ${JSON.stringify(ops)}, 0.9)`), "base64"));
    const dops = [["emblem", "dark", w / 2, h / 2, h, "raster"]];
    await png(b, join(Wd, `sitr-shield-hero-dark${sfx}.png`), w, h, dops, true);
    out(join(Wd, `sitr-shield-hero-dark${sfx}.webp`), Buffer.from(await b.evaluate(`S.webp(${w}, ${h}, ${JSON.stringify(dops)}, 0.9)`), "base64"));
  }
}

async function buildStore(b) {
  console.log("store graphics:");
  const play = join(ROOT, "apps/android/store-listing/assets");
  await renderHtml(b, join(play, "icon-512.html"), join(play, "icon-512.png"), 512, 512);
  await renderHtml(b, join(play, "feature-1024x500.html"), join(play, "feature-1024x500.png"), 1024, 500);
  await renderHtml(b, join(ROOT, "tools/screenshots/promo-tile.html"),
    join(ROOT, "extension/store-listing/assets/promo-tile-440x280.png"), 440, 280);
}

// ------------------------------------------------------------------- social

const THEMES = {
  light: { paper: C.paper, ink: C.ink, soft: C.inkSoft, green: "#0f5c46", gold: "#a37e2c", emblem: "light" },
  dark: { paper: C.darkGround, ink: C.cream, soft: C.inkSoftDark, green: C.darkGreen, gold: C.darkGold, emblem: "dark" },
};
// safe: the box every crop keeps; dx shifts it (LinkedIn keeps clear of the photo).
const FORMATS = {
  "x-header": { w: 1500, h: 500, safe: [1100, 300] },
  "linkedin-banner": { w: 1584, h: 396, safe: [900, 260], dx: 260 },
  "facebook-cover": { w: 1640, h: 624, safe: [1100, 340] },
  "youtube-banner": { w: 2560, h: 1440, safe: [1400, 380] },
  "og-image": { w: 1200, h: 630, safe: [1000, 360] },
  avatar: { w: 800, h: 800, avatar: true },
};

function socialPage(f, t) {
  const logo = (n) => pathToFileURL(join(KIT, "logo", n)).href;
  const base = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${f.w}px;height:${f.h}px;overflow:hidden;background:${t.paper}}
    body{position:relative;font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;color:${t.ink}}
    img{display:block}
  </style>`;
  if (f.avatar) {
    const h = Math.round(f.h * 0.62);
    return `${base}<body style="display:flex;align-items:center;justify-content:center">
      <img data-emblem="${t.emblem}" src="${logo(`sitr-shield-emblem${t.emblem === "dark" ? "-dark" : ""}.png`)}" style="height:${h}px;width:${Math.round(h * EMBLEM_BOX.w / EMBLEM_BOX.h)}px"></body>`;
  }
  // The name lockup, rule, tagline and URL line are the previous banners' (the
  // old render-social.mjs), with the emblem in place of the old mark.
  const [sw, sh] = f.safe;
  const s = Math.min(sh, sw / 3.1); // lockup scale
  const eh = Math.round(s * 0.95), ew = Math.round(eh * EMBLEM_BOX.w / EMBLEM_BOX.h);
  return `${base}<body>
  <div style="position:absolute;left:${(f.w - sw) / 2 + (f.dx || 0)}px;top:${(f.h - sh) / 2}px;width:${sw}px;height:${sh}px;
      display:flex;align-items:center;justify-content:center;gap:${s * 0.16}px">
    <img data-emblem="${t.emblem}" src="${logo(`sitr-shield-emblem${t.emblem === "dark" ? "-dark" : ""}.png`)}" style="height:${eh}px;width:${ew}px;flex:none">
    <div>
      <div style="display:flex;align-items:baseline;gap:${s * 0.09}px;line-height:1">
        <span style="font-size:${s * 0.44}px;font-weight:700;letter-spacing:.01em">Sitr</span>
        <span style="font-size:${s * 0.3}px;color:${t.green};font-family:'Geeza Pro','Noto Naskh Arabic',serif">سِتْر</span>
      </div>
      <div style="width:${s * 0.32}px;height:${Math.max(2, s * 0.008)}px;background:${t.gold};margin:${s * 0.09}px 0 ${s * 0.08}px"></div>
      <div style="font-size:${s * 0.125}px;color:${t.ink};line-height:1.2">A content filter you can audit.</div>
      <div style="margin-top:${s * 0.07}px;font:${s * 0.058}px ui-monospace,'SF Mono',Menlo,monospace;
          letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;color:${t.green}">sitrshield.com · private by construction</div>
    </div>
  </div></body>`;
}

async function buildSocial(b) {
  console.log("brand-kit/social:");
  for (const [name, f] of Object.entries(FORMATS)) {
    for (const [theme, t] of Object.entries(THEMES)) {
      const html = join(b.work, `${name}-${theme}.html`);
      writeFileSync(html, socialPage(f, t));
      await renderHtml(b, html, join(KIT, "social", `${name}-${theme}.png`), f.w, f.h);
    }
  }
  out(join(KIT, "web/og-image.png"), readFileSync(join(KIT, "social/og-image-light.png")));
}

// ------------------------------------------------------------------ preview

async function buildPreview(b) {
  console.log("preview:");
  const html = join(KIT, "preview.html");
  const r = (p) => rel(html, join(ROOT, p));
  const d = (w, h, ops) => b.evaluate(`S.dataUrl(${w}, ${h}, ${JSON.stringify(ops)})`);
  const cmp = [];
  for (const px of [16, 24, 32, 48, 64]) {
    cmp.push(`<figure><div class="pair"><img src="${await d(px, px, [["emblem", "light", px / 2, px / 2, px, "raster"]])}" width="${px}" height="${px}"><img src="${await d(px, px, [["emblem", "light", px / 2, px / 2, px, "small"]])}" width="${px}" height="${px}"></div><figcaption>${px} px: artwork | small mark${px <= SMALL_MAX ? " (used)" : ""}</figcaption></figure>`);
  }
  const darkTile = await d(400, 430, [["rrect", 0, 0, 400, 430, 48, C.white], ["emblem", "light", 200, 215, 360, "raster"]]);
  const s = ICON.android.emblem / EMBLEM_BOX.h, ax = (108 - EMBLEM_BOX.w * s) / 2, ay = (108 - ICON.android.emblem) / 2;
  const mono = `<svg viewBox="18 18 72 72" width="96" height="96"><rect x="18" y="18" width="72" height="72" fill="#d8e3dc"/><path fill="#2e4a3c" fill-rule="evenodd" d="${scalePath(SMALL.silhouette, s, ax, ay)}"/></svg>`;
  const fg = r("apps/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png");
  const adaptive = (shape) => `<div class="adaptive" style="border-radius:${shape}"><img src="${fg}"></div>`;
  const page = `<!doctype html><meta charset="utf-8"><title>Sitr logo: asset preview</title><style>
  body{margin:0;padding:32px;width:1840px;background:#eceae4;font:15px -apple-system,Helvetica,Arial,sans-serif;color:#222}
  h1{font-size:26px;margin:0 0 4px} h2{font-size:18px;margin:26px 0 10px} p{margin:3px 0;color:#555;max-width:1500px}
  .row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end}
  figure{margin:0;padding:12px;background:#fff;border:1px solid #0002;border-radius:8px}
  figure.dk{background:#121a16;color:#ccc} figure.tint{background:#d5dbe2} figcaption{font-size:13px;color:#777;margin-top:8px}
  .pair{display:flex;gap:14px;align-items:center}
  .wall{display:flex;gap:18px;padding:22px;border-radius:14px}
  .ios{width:120px;height:120px;border-radius:26.5px;overflow:hidden;box-shadow:0 2px 8px #0003}
  .adaptive{width:96px;height:96px;overflow:hidden;background:#fff;position:relative;box-shadow:0 1px 4px #0003}
  .adaptive img{position:absolute;width:144px;height:144px;left:-24px;top:-24px}
  .strip{display:flex;gap:10px;align-items:center;padding:8px 14px;border-radius:8px}
  .tab{display:flex;gap:8px;align-items:center;padding:8px 14px;border-radius:8px 8px 0 0;font-size:13px;width:200px}
  </style><body>
  <h1>Sitr logo: every generated asset</h1>
  <p>Shown at real pixel size on its usual ground. The logo is the shield emblem alone (the words under it in the owner's file are not used); the product name stays "Sitr". The emblem is the owner's artwork, cleaned against white, wherever it is drawn more than ${SMALL_MAX} px tall. At ${SMALL_MAX} px and below it is replaced by the <b>small mark</b>, which is our design (solid facets traced from the artwork), shown in the first row so it can be accepted or rejected.</p>
  <h2>1. Owner's artwork vs small mark (left of each pair: artwork resampled; right: small mark)</h2>
  <div class="row">${cmp.join("")}</div>
  <h2>2. App icons</h2>
  <div class="row">
    <figure><div class="wall" style="background:#dfe6ee"><img class="ios" src="${r("apps/ios/Sitr/Assets.xcassets/AppIcon.appiconset/icon_1024.png")}"><img class="ios" style="width:60px;height:60px;border-radius:13px" src="${r("apps/ios/Sitr/Assets.xcassets/AppIcon.appiconset/icon_1024.png")}"></div><figcaption>iOS, light wallpaper (120 and 60 pt)</figcaption></figure>
    <figure><div class="wall" style="background:#1d2430"><img class="ios" src="${r("apps/ios/Sitr/Assets.xcassets/AppIcon.appiconset/icon_1024.png")}"><img class="ios" style="width:60px;height:60px;border-radius:13px" src="${r("apps/ios/Sitr/Assets.xcassets/AppIcon.appiconset/icon_1024.png")}"></div><figcaption>iOS, dark wallpaper</figcaption></figure>
    <figure class="tint"><div class="pair">${adaptive("50%")}${adaptive("30%")}<div style="width:96px;height:96px;border-radius:50%;overflow:hidden">${mono}</div></div><figcaption>Android adaptive: circle, squircle, themed (monochrome layer)</figcaption></figure>
    <figure class="tint"><div class="pair"><img src="${r("apps/ios/SitrMac/Assets.xcassets/AppIcon.appiconset/icon_128@2x.png")}" width="128" height="128"><img src="${r("apps/ios/SitrMac/Assets.xcassets/AppIcon.appiconset/icon_32@2x.png")}" width="32" height="32"><img src="${r("apps/ios/SitrMac/Assets.xcassets/AppIcon.appiconset/icon_16@2x.png")}" width="16" height="16"></div><figcaption>macOS on a grey ground (tile corners are transparent): 128, 32, 16 pt (@2x files; 32 and 16 use the small mark)</figcaption></figure>
  </div>
  <h2>3. Browser extension and favicon</h2>
  <div class="row">
    <figure><div class="strip" style="background:#f1f3f4">${[16, 32, 48, 128].map((px) => `<img src="${r(`extension/public/icon${px}.png`)}" width="${px}" height="${px}">`).join("")}</div><figcaption>Extension icons 16, 32, 48, 128 on a light toolbar</figcaption></figure>
    <figure class="dk"><div class="strip" style="background:#35363a">${[16, 32, 48, 128].map((px) => `<img src="${r(`extension/public/icon${px}.png`)}" width="${px}" height="${px}">`).join("")}</div><figcaption>on a dark toolbar</figcaption></figure>
    <figure><div class="tab" style="background:#fff;border:1px solid #ddd"><img src="${r("brand-kit/web/favicon.svg")}" width="16" height="16">Sitr</div><figcaption>favicon.svg, light tab</figcaption></figure>
    <figure class="dk"><div class="tab" style="background:#3c3c3c;color:#eee"><img src="${r("brand-kit/web/favicon.svg")}" width="16" height="16">Sitr</div><figcaption>dark tab</figcaption></figure>
    <figure class="tint"><img src="${r("brand-kit/web/apple-touch-icon.png")}" width="180" height="180" style="border-radius:40px"><figcaption>apple-touch-icon 180</figcaption></figure>
  </div>
  <h2>4. Store graphics</h2>
  <div class="row">
    <figure class="tint"><img src="${r("apps/android/store-listing/assets/icon-512.png")}" width="512" height="512" style="border-radius:20%"><figcaption>Play icon 512 (Play rounds the corners)</figcaption></figure>
    <figure><img src="${r("apps/android/store-listing/assets/feature-1024x500.png")}" width="1024" height="500"><figcaption>Play feature graphic 1024x500</figcaption></figure>
    <figure><img src="${r("extension/store-listing/assets/promo-tile-440x280.png")}" width="440" height="280"><figcaption>Chrome Web Store promo tile 440x280</figcaption></figure>
    <figure><img src="${r("brand-kit/social/og-image-light.png")}" width="600" height="315"><img src="${r("brand-kit/social/og-image-dark.png")}" width="600" height="315" style="margin-left:10px"><figcaption>og-image 1200x630, light and dark (shown at half size)</figcaption></figure>
  </div>
  <h2>5. The emblem alone, and the two dark treatments</h2>
  <div class="row">
    <figure style="background:#fff"><img src="${r("brand-kit/logo/sitr-shield-emblem.png")}" height="320"><figcaption>emblem (owner's artwork, cleaned)</figcaption></figure>
    <figure class="dk"><img src="${r("brand-kit/logo/sitr-shield-emblem-dark.png")}" height="320"><figcaption>dark A (chosen for banners): recoloured artwork</figcaption></figure>
    <figure class="dk"><img src="${darkTile}" height="320"><figcaption>dark B (store graphics): light emblem on a white tile</figcaption></figure>
    <figure><img src="${r("brand-kit/logo/sitr-shield-small.svg")}" height="160"><figcaption>small mark (48 px and below), vector</figcaption></figure>
  </div>
  </body>`;
  out(html, page);
  await b.navigate(pathToFileURL(html).href, 1904, 1000);
  const hgt = await b.evaluate("document.documentElement.scrollHeight");
  await b.navigate(pathToFileURL(html).href, 1904, hgt);
  out(join(KIT, "preview.png"), await b.shot(1904, hgt));
}

// --------------------------------------------------------------------- main

const STEPS = { masters: buildMasters, icons: buildIcons, web: buildWeb, store: buildStore, social: buildSocial, preview: buildPreview };
const only = process.argv.slice(2);
for (const step of only) if (!STEPS[step]) { console.error(`render-brand: unknown step ${step}`); process.exit(2); }
// A fresh browser per step: a step's pixels never depend on what ran before it
// (glyph and raster caches), so a single step reproduces the full run exactly.
for (const [name, step] of Object.entries(STEPS)) {
  if (only.length && !only.includes(name)) continue;
  const b = await openBrowser();
  await b.navigate("about:blank", 800, 600);
  await loadLib(b);
  await step(b);
  await b.close();
}
console.log("done");
process.exit(0);
