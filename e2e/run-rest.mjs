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
import { randomUUID } from "crypto";
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
let isolatedSessionId = null;

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
    const title = `Waynode E2E ${Date.now()}`;
    const created = await jval(await call("browser_evaluate", {
      script: `return (async () => {
        const token = localStorage.getItem('waynode-dev-token');
        const headers = {'Content-Type':'application/json', 'x-dev-token':token};
        const spacesResponse = await fetch('/api/spaces', {headers, credentials:'include'});
        if (!spacesResponse.ok) return {error:'spaces HTTP '+spacesResponse.status};
        const spaces = await spacesResponse.json();
        if (!spaces.length) return {error:'no space available'};
        const response = await fetch('/api/spaces/'+spaces[0].id+'/sessions', {
          method:'POST', headers, credentials:'include', body:${JSON.stringify(JSON.stringify({ title }))}
        });
        if (!response.ok) return {error:'create HTTP '+response.status};
        return {space:spaces[0], session:await response.json()};
      })();`,
    }));
    if (!created?.session?.id) throw new Error(created?.error || "isolated session was not created");
    isolatedSessionId = created.session.id;
    const shortId = (id) => id.replaceAll("-", "").slice(0, 8).toLowerCase();
    sessionUrl = `${BASE}/${shortId(created.space.id)}/${shortId(created.session.id)}`;
    await call("browser_navigate", { url: sessionUrl, waitUntil: "networkidle", timeout: 30000 });
    await call("browser_wait", { selector: ".workspace-tabs", timeout: 10000 });
    const r = await call("browser_evaluate", { script: "return { url: location.href, tabs: !!document.querySelector('.workspace-tabs') }" });
    const v = await jval(r);
    if (!v?.tabs) throw new Error("session tabs did not render");
    sessionUrl = v.url;
    await shot("02-session");
    console.log(`   ${sessionUrl.slice(0, 60)}…`);
  });

  await flow("chat-send", async () => {
    const nonce = `WAYNODE_E2E_${randomUUID()}`;
    const prompt = `Reply with exactly: ${nonce}`;
    await call("browser_evaluate", {
      script: `const probe = {ready:false, done:false, messageId:null, text:'', error:null};
        const token = localStorage.getItem('waynode-dev-token');
        const stream = new EventSource('/api/sessions/${isolatedSessionId}/stream?t='+encodeURIComponent(token));
        stream.onmessage = (message) => {
          const event = JSON.parse(message.data);
          if (event.type === 'sync') probe.ready = true;
          if (event.type === 'message_start' && !probe.messageId) probe.messageId = event.messageId;
          if (event.type === 'text_delta' && event.messageId === probe.messageId) probe.text += event.delta || '';
          if (event.type === 'error') probe.error = event.message || 'stream error';
          if (event.type === 'end') { probe.done = true; stream.close(); }
        };
        stream.onerror = () => { if (!probe.ready) probe.error = 'stream did not connect'; };
        window.__waynodeChatProbe = probe;
        return true;`,
    });
    let ready = false;
    for (let i = 0; i < 12; i++) {
      await call("browser_wait", { time: 2500 });
      const probe = await jval(await call("browser_evaluate", { script: "return window.__waynodeChatProbe" }));
      if (probe?.error) throw new Error(probe.error);
      if (probe?.ready) { ready = true; break; }
    }
    if (!ready) throw new Error("isolated session stream did not become ready");

    await call("browser_type", { selector: ".composer-input", text: prompt, clearFirst: true, timeout: 10000 });
    await call("browser_click", { selector: ".send-btn", timeout: 8000 });
    let streamed = null;
    for (let i = 0; i < 40; i++) {
      await call("browser_wait", { time: 2500 });
      const probe = await jval(await call("browser_evaluate", { script: "return window.__waynodeChatProbe" }));
      if (probe?.error) throw new Error(probe.error);
      if (probe?.done) { streamed = probe.text.trim(); break; }
    }
    if (streamed !== nonce) throw new Error(`assistant stream mismatch: ${streamed || "no completed reply"}`);

    let persisted = null;
    for (let i = 0; i < 12; i++) {
      await call("browser_wait", { time: 2500 });
      persisted = await jval(await call("browser_evaluate", {
        script: `return (async () => {
          const token = localStorage.getItem('waynode-dev-token');
          const response = await fetch('/api/sessions/${isolatedSessionId}/messages', {headers:{'x-dev-token':token}, credentials:'include'});
          if (!response.ok) return {error:'history HTTP '+response.status};
          const messages = await response.json();
          const userIndex = messages.findIndex(message => message.role === 'user' && message.content === ${JSON.stringify(prompt)});
          const assistant = userIndex < 0 ? null : messages.slice(userIndex + 1).find(message => message.role === 'assistant');
          return {userFound:userIndex >= 0, assistant:assistant?.content || ''};
        })();`,
      }));
      if (persisted?.error) throw new Error(persisted.error);
      if (persisted?.userFound && persisted.assistant.trim() === streamed) break;
    }
    if (!persisted?.userFound || persisted.assistant.trim() !== streamed) {
      throw new Error("assistant reply was streamed but not persisted with its user turn");
    }

    const reloadUrl = await jval(await call("browser_evaluate", { script: "return location.href" }));
    await call("browser_navigate", { url: reloadUrl, waitUntil: "networkidle", timeout: 30000 });
    await call("browser_wait", { selector: ".workspace-tabs", timeout: 10000 });
    let hydrated = false;
    for (let i = 0; i < 12; i++) {
      await call("browser_wait", { time: 2500 });
      hydrated = await jval(await call("browser_evaluate", {
        script: `const replies = [...document.querySelectorAll('.msg-assistant .msg-text')];
          return replies.some(reply => (reply.textContent || '').trim() === ${JSON.stringify(nonce)});`,
      }));
      if (hydrated) break;
    }
    if (!hydrated) throw new Error("persisted assistant reply did not hydrate after reload");
    await shot("03-chat");
    console.log("   assistant streamed, persisted, and rehydrated");
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
  if (isolatedSessionId) {
    const cleanup = await jval(await call("browser_evaluate", {
      script: `return (async () => {
        const token = localStorage.getItem('waynode-dev-token');
        const response = await fetch('/api/sessions/${isolatedSessionId}', {method:'DELETE', headers:{'x-dev-token':token}, credentials:'include'});
        return {ok:response.ok, status:response.status};
      })();`,
    }).catch(() => null));
    if (!cleanup?.ok) console.warn(`isolated session cleanup failed (HTTP ${cleanup?.status || "unknown"})`);
  }
  if (!process.env.KEEP) await call("browser_close_session", {}).catch(() => {});
}

console.log("\n──────── E2E SUMMARY ────────");
for (const r of results) console.log(" " + r);
console.log(`\n${pass} passed, ${fail} failed`);
writeFileSync(join(__dirname, "last-result.json"), JSON.stringify({ pass, fail, results, base: BASE, session: SID, at: new Date().toISOString() }, null, 2));
process.exit(fail ? 1 : 0);
