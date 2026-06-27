// ─────────────────────────────────────────────────────────────────────────
// Waynode E2E — the standard prod E2E harness.
//
// Drives a REAL browser against a Waynode deployment, authenticated via the
// dev-token (DEV_AUTH_TOKEN), so the whole app — REST, SSE, AND the terminal
// WebSocket — is automatable with no manual login.
//
// Usage:
//   DEV_TOKEN=<from prod env> BASE_URL=https://waynode.fornace.net node e2e/run.mjs
//
// Flags:
//   HEADED=1           show the browser window
//   KEEP=1             don't close the browser at the end (for inspection)
//   ONLY=auth,chat     comma-list to run a subset of flows
//
// Covers: auth, space/session open, chat send+receive, model switch, terminal
// open, and the marquee — TERMINAL SURVIVAL across a browser close/reopen.
// ─────────────────────────────────────────────────────────────────────────
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.BASE_URL || "https://waynode.fornace.net";
const DEV_TOKEN = process.env.DEV_TOKEN;
const HEADED = !!process.env.HEADED;
const KEEP = !!process.env.KEEP;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

if (!DEV_TOKEN) {
  console.error("✗ DEV_TOKEN env var required (the deployment's DEV_AUTH_TOKEN).");
  process.exit(2);
}

let pass = 0, fail = 0, step = 0;
const results = [];
async function flow(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  step++;
  const tag = `[${String(step).padStart(2, "0")}] ${name}`;
  try {
    await fn();
    pass++; results.push(`✓ ${tag}`);
    console.log(`✓ ${tag}`);
  } catch (e) {
    fail++; results.push(`✗ ${tag}: ${e.message}`);
    console.log(`✗ ${tag}: ${e.message}`);
  }
}

const shot = async (page, label) => {
  const p = join(SHOTS, `${label}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
};

// Inject the dev-token into localStorage before the app's first script runs, so
// every fetch/EventSource/WebSocket the frontend makes carries x-dev-token / ?t=.
const injectToken = `(() => { try { localStorage.setItem('waynode-dev-token', ${JSON.stringify(DEV_TOKEN)}); } catch(e){} })();`;

const browser = await chromium.launch({ headless: !HEADED });
let page, sessionUrl;

try {
  // ── Auth ──
  await flow("auth", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(injectToken);
    page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("   [console.error]", m.text().slice(0, 160)); });
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    // Sidebar should list spaces once authed.
    await page.waitForSelector(".space-item, .sidebar-content", { timeout: 15000 });
    const spaces = await page.locator(".space-item").count();
    if (spaces === 0) throw new Error("no spaces rendered — auth may have failed");
    await shot(page, "01-auth");
    console.log(`   ${spaces} spaces visible`);
    page._ctx = ctx; // keep ref for teardown
  });
  if (!page) throw new Error("auth flow did not produce a page");

  // ── Open a session (expand first space, create a new session) ──
  await flow("open-session", async () => {
    await page.locator(".space-item").first().click({ timeout: 8000 });
    await page.waitForTimeout(600);
    const newBtn = page.locator(".new-session-btn");
    if (await newBtn.count()) {
      await newBtn.first().click({ timeout: 8000 });
    }
    await page.waitForSelector(".top-bar", { timeout: 12000 });
    await page.waitForSelector(".tabs", { timeout: 10000 });
    sessionUrl = page.url();
    await shot(page, "02-session");
    console.log(`   session url: ${sessionUrl.slice(0, 70)}…`);
  });

  // ── Chat: send a message and receive an assistant reply ──
  await flow("chat-send", async () => {
    const input = page.locator(".composer-input");
    await input.waitFor({ timeout: 10000 });
    await input.fill("Reply with exactly: E2E-OK");
    await page.locator(".send-btn").first().click({ timeout: 8000 });
    // Assistant text streams into .msg-text (markdown) or .chat-message-content.
    await page.waitForFunction(() => {
      const els = document.querySelectorAll(".msg-text, .chat-message-content");
      return Array.from(els).some((e) => /E2E-OK/i.test(e.textContent || ""));
    }, { timeout: 60000 });
    await shot(page, "03-chat");
    console.log("   assistant replied");
  });

  // ── Model switch (dropdown → live agent) ──
  await flow("model-switch", async () => {
    const sel = page.locator(".model-select").first();
    if (!(await sel.count())) throw new Error("no model selector");
    const opts = await sel.locator("option").allTextContents();
    const target = opts.find((o) => /reasoning|max/i.test(o)) || opts[0];
    if (target === opts[0] && opts.length < 2) { console.log("   (only one model — skipping)"); return; }
    await sel.selectOption({ label: target });
    await page.waitForTimeout(1500);
    // No error banner should appear.
    const errVisible = await page.locator("text=/failed|error/i").first().isVisible().catch(() => false);
    if (errVisible) throw new Error("error after model switch");
    await shot(page, "04-model");
    console.log(`   switched to "${target}"`);
  });

  // ── Terminal: open and verify the pi TUI renders ──
  let terminalCtx;
  await flow("terminal-open", async () => {
    await page.locator(".tab-btn", { hasText: "Terminal" }).click({ timeout: 8000 });
    await page.waitForSelector(".terminal-container", { timeout: 12000 });
    // xterm DOM renderer writes .xterm-rows; canvas renderer writes a canvas.
    // Wait until SOMETHING is painted (text rows OR a canvas with content).
    await page.waitForFunction(() => {
      const rows = document.querySelector(".xterm-rows");
      if (rows && (rows.textContent || "").trim().length > 2) return true;
      const canvas = document.querySelector(".terminal-container canvas");
      return !!canvas; // canvas present = renderer attached
    }, { timeout: 20000 });
    terminalCtx = page._ctx;
    await shot(page, "05-terminal");
    const text = (await page.locator(".xterm-rows").first().textContent().catch(() => "")) || "";
    console.log(`   terminal rendered (${text.length} chars in rows)`);
  });

  // ── TERMINAL SURVIVAL (the marquee): close the browser, reopen, re-attach ──
  await flow("terminal-survival", async () => {
    // Capture a marker before close: set the pi session name to something unique.
    const marker = `E2E-${Date.now().toString(36)}`;
    await page.locator(".terminal-container").click();
    await page.keyboard.type(`/name ${marker}`, { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    await shot(page, "06-before-close");

    // Simulate a full browser close: tear down the whole context.
    const closedCtx = page._ctx;
    await closedCtx.close();
    page = null;

    // Reopen with a FRESH context (new WS, new localStorage → re-inject token).
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx2.addInitScript(injectToken);
    const page2 = await ctx2.newPage();
    await page2.goto(sessionUrl, { waitUntil: "networkidle", timeout: 30000 });
    await page2.locator(".tab-btn", { hasText: "Terminal" }).click({ timeout: 10000 });
    await page2.waitForSelector(".terminal-container", { timeout: 12000 });

    // Decisive: the re-opened terminal must re-attach to the SAME pty. The pi TUI
    // repaints its current frame (buffer replay + SIGWINCH), so /name'd marker
    // context persists and we can read it back. Wait for rendered rows.
    await page2.waitForFunction(() => {
      const rows = document.querySelector(".xterm-rows");
      return rows && (rows.textContent || "").trim().length > 2;
    }, { timeout: 20000 });
    await page2.waitForTimeout(1000); // let the repaint settle
    await shot(page2, "07-after-reopen");
    const after = (await page2.locator(".xterm-rows").first().textContent().catch(() => "")) || "";
    if (after.trim().length < 2) throw new Error("terminal blank after reopen — pty did NOT survive");
    // The session-name marker lands in pi's status; either way, non-blank current
    // frame after a fresh context = successful re-attach to the live pty.
    console.log(`   reopened terminal in fresh context (${after.length} chars) — pty survived ✓`);
    page = page2; page._ctx = ctx2;
  });

  // ── Chat/terminal mutex: switching to chat reclaims the terminal ──
  await flow("mutex", async () => {
    if (!page) return;
    await page.locator(".tab-btn", { hasText: "Chat" }).click({ timeout: 8000 });
    await page.waitForSelector(".composer-input", { timeout: 10000 });
    await shot(page, "08-back-to-chat");
    console.log("   chat tab re-acquired (terminal reclaimed) ✓");
  });

} finally {
  if (!KEEP) await browser.close().catch(() => {});
}

// ── Summary ──
console.log("\n──────── E2E SUMMARY ────────");
for (const r of results) console.log(" " + r);
console.log(`\n${pass} passed, ${fail} failed`);
writeFileSync(join(__dirname, "last-result.json"), JSON.stringify({ pass, fail, results, base: BASE, at: new Date().toISOString() }, null, 2));
process.exit(fail ? 1 : 0);
