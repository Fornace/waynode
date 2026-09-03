/**
 * Live resilience acceptance: real server + real pi, two independent SSE
 * clients, tool call in flight, browser A closes, server is SIGKILLed, boot
 * recovery resumes the turn, and client C sees the durable final transcript.
 *
 * Requires LLM_API_KEY / LLM_BASE_URL (CI/prod-like integration only).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.env.LLM_API_KEY) {
  console.log("live session resilience: SKIP (LLM_API_KEY absent)");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "waynode-live-resilience-"));
const data = join(root, "data");
const repo = join(root, "repo");
const markerFile = join(repo, "tool-side-effect.txt");
const port = 48100 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const token = "resilience-dev-token";
let server = null;
let passed = false;
let liveSessionDir = null;

function snapshotSession(label) {
  if (!liveSessionDir || !existsSync(liveSessionDir)) return;
  const destination = join(root, "artifacts", label);
  mkdirSync(join(root, "artifacts"), { recursive: true });
  cpSync(liveSessionDir, destination, { recursive: true });
  console.log(`  captured ${label}: ${destination}`);
}

function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: data, PORT: String(port), APP_URL: base,
      DEV_AUTH_TOKEN: token, DEV_USER_NAME: "Resilience Test",
      NODE_ENV: "production", WAYNODE_DEPLOYMENT: "self-hosted",
      PI_DEFAULT_PROVIDER: "fornace", PI_DEFAULT_MODEL: "fornace-fast",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => process.stdout.write(`[server] ${c}`));
  server.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));
  return server;
}
async function waitLive(timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health/live`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become live");
}
function auth(extra = {}) { return { "x-dev-token": token, ...extra }; }
async function json(url, options = {}) {
  const response = await fetch(`${base}${url}`, { ...options, headers: auth(options.headers) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
class StreamReader {
  constructor(sessionId) { this.sessionId = sessionId; this.abort = new AbortController(); this.events = []; this.waiters = []; }
  async open() {
    const response = await fetch(`${base}/api/sessions/${this.sessionId}/stream?t=${token}`, { signal: this.abort.signal });
    if (!response.ok) throw new Error(`stream ${response.status}`);
    this.readTask = this.read(response.body).catch((error) => {
      if (error.name !== "AbortError" && !String(error.message).includes("terminated")) this.error = error;
    });
  }
  async read(body) {
    const decoder = new TextDecoder(); let buffer = "";
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        if (!data) continue;
        const event = JSON.parse(data); this.events.push(event);
        for (const waiter of [...this.waiters]) if (waiter.predicate(event)) { waiter.resolve(event); this.waiters.splice(this.waiters.indexOf(waiter), 1); }
      }
    }
  }
  waitFor(predicate, timeout = 90_000) {
    const existing = this.events.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => { const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1); reject(new Error(`stream timeout; events=${this.events.map((e) => e.type).join(",")}`)); }, timeout).unref();
    });
  }
  close() { this.abort.abort(); }
}

try {
  mkdirSync(data, { recursive: true }); mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  startServer(); await waitLive();
  await json("/api/auth/me"); // seed dev user + org
  const db = new DatabaseSync(join(data, "waynode.db"));
  db.prepare("INSERT INTO spaces (id, owner_id, repo_url, repo_name, branch, local_path) VALUES (?,?,?,?,?,?)")
    .run("space-live", "dev-user", "https://example.com/live.git", "live", "main", repo);
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?,?,?)")
    .run("space-live", "dev-user", "admin");
  const session = await json("/api/spaces/space-live/sessions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Live resilience", model: "fornace-fast", provider: "fornace" }),
  });
  liveSessionDir = session.pi_session_dir;

  const a = new StreamReader(session.id); const b = new StreamReader(session.id);
  await a.open(); await b.open();
  await Promise.all([a.waitFor((e) => e.type === "sync"), b.waitFor((e) => e.type === "sync")]);

  const submissionId = crypto.randomUUID();
  await json(`/api/sessions/${session.id}/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      submissionId, mode: "message",
      prompt: "Use the bash tool to run exactly this command: sleep 4; printf 'LIVE-TOOL-ONCE\\n' >> tool-side-effect.txt; sleep 20; echo LIVE-RESILIENCE-MARKER. After it finishes, reply with exactly LIVE-RESILIENCE-DONE.",
    }),
  });
  await Promise.all([
    a.waitFor((e) => e.type === "tool_start" && e.toolName === "bash"),
    b.waitFor((e) => e.type === "tool_start" && e.toolName === "bash"),
  ]);
  console.log("  two devices saw the same live tool call");
  const effectDeadline = Date.now() + 30_000;
  while (!existsSync(markerFile) && Date.now() < effectDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(existsSync(markerFile), true, "tool side effect happened before the crash");
  a.close();
  assert.equal(b.events.some((e) => e.type === "tool_start"), true, "client B remains live after A closes");
  snapshotSession("pre-kill");

  server.kill("SIGKILL"); await new Promise((resolve) => server.once("exit", resolve));
  snapshotSession("post-kill-pre-recovery");
  console.log("  server crashed mid-tool; restarting with the same durable data");
  startServer(); await waitLive();
  const c = new StreamReader(session.id); await c.open();
  await c.waitFor((e) => e.type === "resumed", 30_000);
  console.log("  client C saw automatic recovery");
  const final = await c.waitFor((e) => e.type === "entries" && (e.entries || []).some((entry) =>
    entry.role === "assistant" && (entry.blocks || []).some((block) => block.type === "text" && block.text.includes("LIVE-RESILIENCE-DONE"))), 120_000);
  assert.ok(final, "resumed turn persists the final assistant entry");
  const persisted = await json(`/api/sessions/${session.id}/events`);
  const texts = persisted.items.flatMap((entry) => entry.blocks || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.match(texts, /LIVE-RESILIENCE-DONE/, "new device reload gets the durable final answer");
  assert.ok(persisted.items.some((entry) => entry.role === "toolResult"), "tool result survives reload");
  assert.equal(readFileSync(markerFile, "utf8"), "LIVE-TOOL-ONCE\n",
    "recovery never executes an interrupted side effect twice");
  snapshotSession("post-settlement");
  c.close(); b.close();
  passed = true;
  console.log("live session resilience: PASS (two clients + close + crash + recovery + reload)");
} finally {
  try { server?.kill("SIGKILL"); } catch {}
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`live session resilience artifacts retained at ${root}`);
}
