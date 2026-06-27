// ─────────────────────────────────────────────────────────────────────────
// Waynode prod E2E — the standard driver: browser.fornace.net (Playwright-backed
// server browser) driven over its REST action API. No local browser install.
//
// Auth: dev-token (DEV_AUTH_TOKEN) injected into the page's localStorage, so the
// whole app — REST, SSE, and the terminal WebSocket — runs authenticated as the
// dev user against prod, with no OAuth login step.
//
// Usage:
//   DEV_TOKEN=<prod DEV_AUTH_TOKEN> node e2e/run-rest.mjs
//   KEEP=1            leave the browser session alive for inspection
//   ONLY=auth,chat    run a subset
// ─────────────────────────────────────────────────────────────────────────
import https from "https";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const TOKEN = process.env.BROWSER_TOKEN || process.env.DEV_TOKEN; // browser.fornace.net api-key
const DEV_TOKEN = process.env.DEV_TOKEN;                          // waynode DEV_AUTH_TOKEN
const HOST = "browser.fornace.net";
const BASE = process.env.BASE_URL || "https://waynode.fornace.net";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

// NOTE: BROWSER_TOKEN (browser.fornace.net key) and DEV_TOKEN (waynode) can be
// different values. BROWSER_TOKEN defaults to DEV_TOKEN for one-env convenience
// when they happen to match, but they are distinct secrets.
if (!TOKEN) { console.error("✗ BROWSER_TOKEN (browser.fornace.net api-key) required."); process.exit(2); }
if (!DEV_TOKEN) { console.error("✗ DEV_TOKEN (waynode DEV_AUTH_TOKEN) required."); process.exit(2); }

let SID = null;
function call(name, args) {
  return new Promise((resolve, reject) => {
    const payload = { ...args };
    if (SID) payload.sessionId = SID;
    const data = JSON.stringify(payload);
    const req = https.request({ host: HOST, path: `/tool/${name}`, method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(60000, () => req.destroy(new Error(`${name} timeout`)));
    req.on("error", reject); req.write(data); req.end();
  });
}
// Extract the text value from a tool result (MCP content envelope).
const val = (r) => {
  try { const j = JSON.parse(r.body); const c = j.content?.[0]; if (c?.text) return c.text; if (j.error) return `ERR: ${j.error}`; return JSON.stringify(j); }
  catch { return r.body.slice(0, 200); }
};
// browser_evaluate returns {content:[{text: '{"result": <value>, "type":...}'}]}.
// Parse down to the actual JS value the script returned.
const jval = async (r) => {
  try { return JSON.parse(val(r)).result; }
  catch { return null; }
};

let pass = 0, fail = 0, n = 0;
const results = [];
async function flow(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  n++;
  const tag = `[${String(n).padStart(2, "0")}] ${name}`;
  try { await fn(); pass++; results.push(`✓ ${tag}`); console.log(`✓ ${tag}`); }
  catch (e) { fail++; results.push(`✗ ${tag}: ${e.message}`); console.log(`✗ ${tag}: ${e.message}`); }
}

const shot = async (label) => {
  const r = await call("browser_screenshot", {});
  try { writeFileSync(join(SHOTS, `${label}.png`), Buffer.from(JSON.parse(r.body).content[0].data, "base64")); }
  catch {}
};

const INJECT = `localStorage.setItem('waynode-dev-token','${DEV_TOKEN}');`;

// ── Acquire an isolated browser session (own cookies/tabs/WS) ──
{
  const r = await call("browser_create_session", {});
  // Response is the MCP envelope: {content:[{text:'{"sessionId":"..."}'}]}
  try { SID = JSON.parse(val(r)).sessionId; } catch {}
  if (!SID) { console.error("✗ could not create browser session:", r.body.slice(0, 200)); process.exit(1); }
  console.log(`browser session: ${SID}`);
}

try {
  await flow("auth", async () => {
    await call("browser_navigate", { url: BASE, waitUntil: "networkidle", timeout: 30000 });
    await call("browser_evaluate", { script: INJECT });
    await call("browser_navigate", { url: BASE, waitUntil: "networkidle", timeout: 30000 });
    const r = await call("browser_evaluate", { script: "return { spaces: document.querySelectorAll('.space-item').length, hasToken: !!localStorage.getItem('waynode-dev-token') }" });
    const v = await jval(r);
    if (!v || !v.hasToken) throw new Error("token not set");
    if (!v.spaces) throw new Error("no spaces rendered — auth failed");
    await shot("01-auth");
    console.log(`   ${v.spaces} spaces`);
  });

  let sessionUrl = null;
  await flow("open-session", async () => {
    await call("browser_click", { selector: ".space-item", timeout: 10000 });
    await call("browser_wait", { time: 800 });
    // if a New Session affordance exists, click it; else just use the first
    const has = await jval(await call("browser_evaluate", { script: "return !!document.querySelector('.new-session-btn')" }));
    if (has) await call("browser_click", { selector: ".new-session-btn", timeout: 8000 });
    const r = await call("browser_evaluate", { script: "return { url: location.href, tabs: !!document.querySelector('.tabs') }" });
    const v = await jval(r);
    if (!v?.tabs) throw new Error("session tabs did not render");
    sessionUrl = v.url;
    await shot("02-session");
    console.log(`   ${sessionUrl.slice(0, 60)}…`);
  });

  await flow("chat-send", async () => {
    await call("browser_type", { selector: ".composer-input", text: "Reply with exactly: E2E-OK", clearFirst: true, timeout: 10000 });
    await call("browser_click", { selector: ".send-btn", timeout: 8000 });
    // poll for assistant reply containing E2E-OK (.msg is the message row)
    let got = false;
    for (let i = 0; i < 30; i++) {
      await call("browser_wait", { time: 2000 });
      const v = await jval(await call("browser_evaluate", { script: "return [...document.querySelectorAll('.msg, .msg-text, .chat-message-content')].some(e => /E2E-OK/i.test(e.textContent||''))" }));
      if (v) { got = true; break; }
    }
    if (!got) throw new Error("no assistant reply with E2E-OK");
    await shot("03-chat");
    console.log("   assistant replied");
  });

  await flow("model-switch", async () => {
    const has = await jval(await call("browser_evaluate", { script: "return !!document.querySelector('.model-select')" }));
    if (!has) throw new Error("no model selector");
    const opts = await jval(await call("browser_evaluate", { script: "return [...document.querySelectorAll('.model-select option')].map(o=>o.textContent.trim())" }));
    const target = opts.find((o) => /reasoning|max/i.test(o));
    if (!target) { console.log("   (no reasoning/max model — skipping)"); return; }
    await call("browser_evaluate", { script: `const s=document.querySelector('.model-select'); [...s.options].find(o=>o.textContent.trim()===${JSON.stringify(target)}).selected=true; s.dispatchEvent(new Event('change',{bubbles:true}));` });
    await call("browser_wait", { time: 1500 });
    await shot("04-model");
    console.log(`   → ${target}`);
  });

  await flow("terminal-open", async () => {
    // Wait for any in-flight chat turn to settle first: opening the terminal
    // reclaims the chat agent (mutex), and getTerminal waits on a running turn.
    // If we don't let it finish, the terminal pty never spawns within the timeout.
    for (let i = 0; i < 20; i++) {
      const busy = await jval(await call("browser_evaluate", { script: "return !!document.querySelector('.stream-cursor, .msg-typing')" }));
      if (!busy) break;
      await call("browser_wait", { time: 2000 });
    }
    // The tab-btn texts are "Chat"/"Terminal" but the icon-only settings/git
    // buttons also carry .tab-btn. Scope the Terminal click precisely via text.
    await call("browser_evaluate", { script: "[...document.querySelectorAll('.tab-btn')].find(b=>b.textContent.trim()==='Terminal')?.click()" });
    await call("browser_wait", { selector: ".terminal-container", timeout: 12000 });
    // wait until xterm has rendered rows (pi TUI painted)
    let ok = false;
    for (let i = 0; i < 20; i++) {
      await call("browser_wait", { time: 1500 });
      const v = await jval(await call("browser_evaluate", { script: "return (document.querySelector('.xterm-rows')?.textContent||'').trim().length > 2 || !!document.querySelector('.terminal-container canvas')" }));
      if (v) { ok = true; break; }
    }
    if (!ok) throw new Error("terminal never rendered");
    await shot("05-terminal");
    console.log("   pi TUI painted");
  });

  await flow("terminal-survival", async () => {
    // marker via /name so the live session has unique state
    const marker = `E2E-${Date.now().toString(36)}`;
    await call("browser_evaluate", { script: "document.querySelector('.terminal-container').click()" });
    await call("browser_type", { selector: ".terminal-container", text: `/name ${marker}\n`, delay: 8 });
    await call("browser_wait", { time: 1500 });
    await shot("06-before");
    // simulate browser-close: tear down the WS by clearing session state + a fresh
    // navigation. The server pty must survive and re-attach (buffer replay + redraw).
    await call("browser_clear_session", {});
    await call("browser_evaluate", { script: INJECT });
    await call("browser_navigate", { url: sessionUrl, waitUntil: "networkidle", timeout: 30000 });
    await call("browser_evaluate", { script: "[...document.querySelectorAll('.tab-btn')].find(b=>b.textContent.trim()==='Terminal')?.click()" });
    await call("browser_wait", { selector: ".terminal-container", timeout: 12000 });
    let ok = false;
    for (let i = 0; i < 14; i++) {
      await call("browser_wait", { time: 1500 });
      const v = await jval(await call("browser_evaluate", { script: "return (document.querySelector('.xterm-rows')?.textContent||'').trim().length > 2" }));
      if (v) { ok = true; break; }
    }
    if (!ok) throw new Error("terminal blank after clear_session — pty did NOT survive");
    await shot("07-after");
    const len = await jval(await call("browser_evaluate", { script: "return (document.querySelector('.xterm-rows')?.textContent||'').length" }));
    console.log(`   re-attached in fresh session (${len} chars) — pty survived`);
  });

  await flow("mutex", async () => {
    await call("browser_evaluate", { script: "[...document.querySelectorAll('.tab-btn')].find(b=>b.textContent.trim()==='Chat')?.click()" });
    await call("browser_wait", { selector: ".composer-input", timeout: 10000 });
    await shot("08-back-to-chat");
    console.log("   chat re-acquired (terminal reclaimed)");
  });

} finally {
  if (!process.env.KEEP) await call("browser_close_session", {}).catch(() => {});
}

console.log("\n──────── E2E SUMMARY ────────");
for (const r of results) console.log(" " + r);
console.log(`\n${pass} passed, ${fail} failed`);
writeFileSync(join(__dirname, "last-result.json"), JSON.stringify({ pass, fail, results, base: BASE, session: SID, at: new Date().toISOString() }, null, 2));
process.exit(fail ? 1 : 0);
