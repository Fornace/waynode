// Offline/local Playwright fallback for Waynode's current web contract.
// The canonical remote driver remains run-rest.mjs.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 DEV_TOKEN=<DEV_AUTH_TOKEN> node e2e/run.mjs
//   HEADED=1 KEEP=1 ONLY=auth,open-session,chat-send,model-switch ...
import { chromium } from "playwright";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "shots");
mkdirSync(shots, { recursive: true });

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const DEV_TOKEN = process.env.DEV_TOKEN;
const HEADED = process.env.HEADED === "1";
const KEEP = process.env.KEEP === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const UI_TIMEOUT = 15_000;
const NAV_TIMEOUT = 30_000;
const API_TIMEOUT = 15_000;
const TURN_TIMEOUT = 120_000;

const target = new URL(BASE);
const loopback = ["127.0.0.1", "localhost", "::1"].includes(target.hostname);
if (!DEV_TOKEN) quit("DEV_TOKEN env var is required", 2);
if (target.hostname === "waynode.fornace.net") quit("The local fallback refuses production", 2);
if (!loopback && process.env.WAYNODE_NONPROD_CONFIRMED !== "1") {
  quit("Set WAYNODE_NONPROD_CONFIRMED=1 for a non-loopback staging origin", 2);
}

let passed = 0;
let failed = 0;
let step = 0;
const results = [];
let browser;
let context;
let page;
let isolatedSessionId;
let sessionUrl;

async function flow(name, action) {
  if (ONLY && !ONLY.has(name)) return;
  const tag = `[${String(++step).padStart(2, "0")}] ${name}`;
  try {
    await action();
    passed++;
    results.push(`✓ ${tag}`);
    console.log(`✓ ${tag}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    results.push(`✗ ${tag}: ${message}`);
    console.error(`✗ ${tag}: ${message}`);
  }
}

async function api(path, options = {}) {
  const response = await context.request.fetch(path, {
    ...options,
    timeout: API_TIMEOUT,
    headers: { "x-dev-token": DEV_TOKEN, ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`${options.method || "GET"} ${path} → ${response.status()}: ${body?.error || "request failed"}`);
  return body;
}

async function screenshot(label) {
  if (!page) return;
  await page.screenshot({ path: join(shots, `${label}.png`), timeout: 10_000 }).catch(() => {});
}

async function poll(description, action, timeout = TURN_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await action();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${description} timed out${last?.error ? `: ${last.error}` : ""}`);
}

function shortId(id) {
  return id.replaceAll("-", "").slice(0, 8).toLowerCase();
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

try {
  browser = await chromium.launch({ headless: !HEADED, timeout: NAV_TIMEOUT });
  context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { "x-dev-token": DEV_TOKEN },
  });
  await context.addInitScript((token) => {
    try { localStorage.setItem("waynode-dev-token", token); } catch {}
  }, DEV_TOKEN);
  page = await context.newPage();
  page.setDefaultTimeout(UI_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`   [console.error] ${message.text().slice(0, 180)}`);
  });

  await flow("auth", async () => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const [orgs, spaces] = await Promise.all([api("/api/orgs"), api("/api/spaces")]);
    if (!Array.isArray(orgs) || !orgs[0]?.id) throw new Error("authenticated organization was not returned");
    if (!Array.isArray(spaces) || !spaces[0]?.id) throw new Error("authenticated worktree was not returned");
    await page.locator(".space-item").first().waitFor({ state: "visible", timeout: UI_TIMEOUT });
    if (await page.locator(".login-page, .login-card").count()) throw new Error("login remained visible after token injection");
    await screenshot("01-local-auth");
    console.log(`   ${spaces.length} worktree${spaces.length === 1 ? "" : "s"}`);
  });

  await flow("open-session", async () => {
    const spaces = await api("/api/spaces");
    const space = spaces[0];
    if (!space?.id) throw new Error("no worktree available for an isolated session");
    const session = await api(`/api/spaces/${space.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      data: { title: `Waynode local E2E ${Date.now()}` },
    });
    if (!session?.id) throw new Error("isolated session was not created");
    isolatedSessionId = session.id;
    sessionUrl = `${BASE}/${shortId(space.id)}/${shortId(session.id)}`;
    await page.goto(sessionUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.locator(".composer-input").waitFor({ state: "visible", timeout: UI_TIMEOUT });
    await page.waitForFunction(() => document.querySelector(".session-run-state")?.textContent?.trim() === "Ready", null, { timeout: UI_TIMEOUT });
    await screenshot("02-local-session");
  });

  await flow("chat-send", async () => {
    if (!isolatedSessionId) throw new Error("open-session did not create a session");
    const nonce = `WAYNODE_LOCAL_E2E_${randomUUID()}`;
    const prompt = `Reply with exactly: ${nonce}`;
    await page.locator(".composer-input").fill(prompt, { timeout: UI_TIMEOUT });
    await page.locator(".send-btn").click({ timeout: UI_TIMEOUT });
    await page.waitForFunction((expected) => [...document.querySelectorAll(".msg-assistant .msg-text")]
      .some((node) => node.textContent?.trim() === expected), nonce, { timeout: TURN_TIMEOUT });

    const persisted = await poll("message persistence", async () => {
      const messages = await api(`/api/sessions/${isolatedSessionId}/messages`);
      const userIndex = messages.findIndex((message) => message.role === "user" && message.content === prompt);
      const assistant = userIndex < 0 ? null : messages.slice(userIndex + 1).find((message) => message.role === "assistant");
      if (userIndex < 0 || assistant?.content?.trim() !== nonce) return null;
      return { user: messages[userIndex], assistant };
    });
    if (!validTimestamp(persisted.user.timestamp) || !validTimestamp(persisted.assistant.timestamp)) {
      throw new Error("persisted turn did not include valid source timestamps");
    }

    await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.locator(".composer-input").waitFor({ state: "visible", timeout: UI_TIMEOUT });
    const userRow = page.locator(".msg-user").filter({ hasText: prompt }).last();
    const assistantRow = page.locator(".msg-assistant").filter({ hasText: nonce }).last();
    await assistantRow.waitFor({ state: "visible", timeout: UI_TIMEOUT });
    if (!(await userRow.locator("time.msg-time").count()) || !(await assistantRow.locator("time.msg-time").count())) {
      throw new Error("rehydrated turn did not render its timestamps");
    }
    await screenshot("03-local-chat");
    console.log("   assistant streamed, persisted, rehydrated, and timestamped");
  });

  await flow("model-switch", async () => {
    if (!isolatedSessionId) throw new Error("open-session did not create a session");
    await page.getByRole("button", { name: "Session menu" }).click({ timeout: UI_TIMEOUT });
    const select = page.locator(".session-command-menu select");
    await select.waitFor({ state: "visible", timeout: UI_TIMEOUT });
    await page.waitForFunction(() => document.querySelectorAll(".session-command-menu select option").length > 0, null, { timeout: UI_TIMEOUT });
    const options = await select.locator("option").evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, label: node.textContent?.trim() || node.value })));
    const current = await select.inputValue({ timeout: UI_TIMEOUT });
    const targetModel = options.find((option) => option.value !== current);
    if (!targetModel) {
      console.log("   one configured model; switch not applicable");
      return;
    }
    await select.selectOption(targetModel.value, { timeout: UI_TIMEOUT });
    await poll("model persistence", async () => (await api(`/api/sessions/${isolatedSessionId}`)).model === targetModel.value);
    if (await page.locator("[role='alert']").filter({ hasText: /model/i }).count()) throw new Error("model change surfaced an error");
    await screenshot("04-local-model");
    console.log(`   ${current} → ${targetModel.value}`);
  });
} finally {
  if (isolatedSessionId && context) {
    await context.request.delete(`/api/sessions/${isolatedSessionId}`, {
      headers: { "x-dev-token": DEV_TOKEN }, timeout: API_TIMEOUT,
    }).then((response) => {
      if (!response.ok()) console.warn(`isolated session cleanup failed (HTTP ${response.status()})`);
    }).catch((error) => console.warn(`isolated session cleanup failed: ${error.message}`));
  }
  if (!KEEP) {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

console.log("\n──────── LOCAL E2E SUMMARY ────────");
for (const result of results) console.log(` ${result}`);
console.log(`\n${passed} passed, ${failed} failed`);
writeFileSync(join(here, "last-result.json"), JSON.stringify({ pass: passed, fail: failed, results, base: BASE, at: new Date().toISOString() }, null, 2));
process.exit(failed ? 1 : 0);

function quit(message, code) {
  console.error(`✗ ${message}`);
  process.exit(code);
}
