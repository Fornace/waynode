// ─────────────────────────────────────────────────────────────────────────
// Waynode prod E2E — the standard driver: browser.fornace.net (Playwright-backed
// server browser) driven over its REST action API. No local browser install.
//
// Auth: dev-token (DEV_AUTH_TOKEN) injected into the page's localStorage, so the
// whole app — REST, SSE, and the terminal capability check — runs authenticated
// as the dev user against hosted prod, with no OAuth login step.
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
// Raw single HTTP call to a /tool/<name> action.
function callOnce(name, args) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate-limit-aware call: browser.fornace.net throttles sustained call volume
// (no advertised headers, just {error:"Rate limit exceeded"}). Detect it and
// back off + retry so the harness stays consistent instead of failing late.
async function call(name, args) {
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await callOnce(name, args);
    // detect throttle: HTTP 200 but body says Rate limit, OR 429
    const throttled = r.status === 429 || (typeof r.body === "string" && r.body.includes("Rate limit exceeded"));
    if (!throttled) return r;
    lastErr = r;
    // exponential backoff: 3s, 6s, 12s, 24s, 48s
    await sleep(3000 * 2 ** attempt);
  }
  return lastErr;
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
    await call("browser_wait", { selector: ".space-sessions", timeout: 8000 });
    // Expanding a space reveals its sessions. Prefer one of those so the
    // smoke test does not create unnecessary production sessions; create a
    // session only when the space is genuinely empty.
    const hasSession = await jval(await call("browser_evaluate", { script: "return !!document.querySelector('.space-sessions .session-item')" }));
    if (hasSession) {
      await call("browser_click", { selector: ".space-sessions .session-item", timeout: 8000 });
    } else {
      await call("browser_click", { selector: ".space-sessions .new-session-btn", timeout: 8000 });
    }
    await call("browser_wait", { selector: ".workspace-tabs", timeout: 10000 });
    const r = await call("browser_evaluate", { script: "return { url: location.href, tabs: !!document.querySelector('.workspace-tabs') }" });
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
      await call("browser_wait", { time: 3000 });
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
    await call("browser_wait", { time: 2500 });
    await shot("04-model");
    console.log(`   → ${target}`);
  });

  let terminalGateOpened = false;
  await flow("hosted-terminal-disabled", async () => {
    // Hosted production must fail closed even for an authenticated, paid user.
    // Wait for chat to settle so an agent-busy response cannot mask the
    // deployment capability decision.
    for (let i = 0; i < 20; i++) {
      const busy = await jval(await call("browser_evaluate", { script: "return !!document.querySelector('.stream-cursor, .msg-typing')" }));
      if (!busy) break;
      await call("browser_wait", { time: 3000 });
    }

    const initiallyVisible = await jval(await call("browser_evaluate", {
      script: "return [...document.querySelectorAll('.workspace-tabs button')].some(b=>b.textContent.trim()==='Terminal')",
    }));
    if (!initiallyVisible) {
      console.log("   terminal capability already hidden");
      return;
    }

    await call("browser_evaluate", { script: "[...document.querySelectorAll('.workspace-tabs button')].find(b=>b.textContent.trim()==='Terminal').click()" });
    await call("browser_wait", { selector: ".terminal-container", timeout: 12000 });
    let state = null;
    for (let i = 0; i < 12; i++) {
      await call("browser_wait", { time: 2500 });
      state = await jval(await call("browser_evaluate", {
        script: `const text=(document.querySelector('.terminal-container')?.textContent||'').toLowerCase();
          return {
            unavailable: text.includes('terminal unavailable') && text.includes('not available on waynode cloud'),
            hidden: ![...document.querySelectorAll('.workspace-tabs button')].some(b=>b.textContent.trim()==='Terminal'),
            output: (document.querySelector('.xterm-rows')?.textContent||'').trim().length,
          }`,
      }));
      if (state?.unavailable && state?.hidden) break;
    }
    if (!state?.unavailable) throw new Error("hosted terminal did not show its capability denial");
    if (!state.hidden) throw new Error("Terminal control remained visible after hosted denial");
    if (state.output > 0) throw new Error("hosted terminal produced interactive output before denial");
    terminalGateOpened = true;
    await shot("05-terminal-disabled");
    console.log("   hosted capability denied and hidden");
  });

  await flow("chat-after-terminal-gate", async () => {
    if (terminalGateOpened) {
      await call("browser_evaluate", { script: "[...document.querySelectorAll('.terminal-state-actions button')].find(b=>b.textContent.trim()==='Return to chat')?.click()" });
    }
    await call("browser_wait", { selector: ".composer-input", timeout: 10000 });
    const hidden = await jval(await call("browser_evaluate", {
      script: "return ![...document.querySelectorAll('.workspace-tabs button')].some(b=>b.textContent.trim()==='Terminal')",
    }));
    if (!hidden) throw new Error("Terminal control reappeared after returning to chat");
    await shot("06-back-to-chat");
    console.log("   chat remained available; terminal stayed hidden");
  });

} finally {
  if (!process.env.KEEP) await call("browser_close_session", {}).catch(() => {});
}

console.log("\n──────── E2E SUMMARY ────────");
for (const r of results) console.log(" " + r);
console.log(`\n${pass} passed, ${fail} failed`);
writeFileSync(join(__dirname, "last-result.json"), JSON.stringify({ pass, fail, results, base: BASE, session: SID, at: new Date().toISOString() }, null, 2));
process.exit(fail ? 1 : 0);
