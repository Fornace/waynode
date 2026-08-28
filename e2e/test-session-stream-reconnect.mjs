/**
 * Regression coverage for streaming/store bugs in sessionStore/sessionTransport.
 * Failing-first: written BEFORE the lib fixes; each case asserts the post-fix shape.
 * Standalone runner: `node e2e/test-session-stream-reconnect.mjs`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

// ── Module loader: recursively transpile TS to data URLs (react stubbed). ──
const ts = await import(pathToFileURL(`${process.cwd()}/frontend/node_modules/typescript/lib/typescript.js`).href);
const REACT_STUB = "data:text/javascript;base64," + Buffer.from(
  "export function useSyncExternalStore(_s, getSnapshot){ return getSnapshot(); }",
).toString("base64");
const transpileCache = new Map();
function resolveRelative(containingDir, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolvePath(containingDir, spec);
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
    try { readFileSync(base + ext); return base + ext; } catch {}
  }
  return null;
}
function transpileToDataUrl(filePath) {
  if (transpileCache.has(filePath)) return transpileCache.get(filePath);
  const source = readFileSync(filePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const dir = dirname(filePath);
  const rewritten = outputText
    .replace(/(from\s+|import\(\s*)["'](\.[^"']+)["']/g, (m, pre, spec) => {
      const resolved = resolveRelative(dir, spec);
      return resolved ? `${pre}"${transpileToDataUrl(resolved)}"` : m;
    })
    .replace(/from\s+["']react["']/g, `from "${REACT_STUB}"`);
  const url = `data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`;
  transpileCache.set(filePath, url);
  return url;
}

// ── Global stubs: deterministic clock, fetch, EventSource, localStorage. ──
const timeouts = [];
const intervals = new Map();
let nextTimerId = 1;
globalThis.setTimeout = (fn) => { const id = nextTimerId++; timeouts.push({ id, fn }); return id; };
globalThis.clearTimeout = (id) => {
  const idx = timeouts.findIndex((t) => t.id === id);
  if (idx !== -1) timeouts.splice(idx, 1);
};
globalThis.setInterval = (fn) => { const id = nextTimerId++; intervals.set(id, fn); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); };
async function flushMicrotasks(depth = 40) {
  for (let i = 0; i < depth; i++) await Promise.resolve();
}
async function flushTimers() {
  let guard = 0;
  while (timeouts.length && guard++ < 50) {
    const t = timeouts.shift();
    t.fn();
    await flushMicrotasks();
  }
  await flushMicrotasks();
}
function intervalCount() { return intervals.size; }

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};

let fetchRoutes = []; // [{match, respond}] respond: () => Promise<{ok, json}>
let fetchCallLog = [];
globalThis.fetch = async (url, opts) => {
  fetchCallLog.push({ url, opts });
  for (const route of fetchRoutes) {
    if (route.match(url, opts)) return route.respond();
  }
  throw new Error(`unmocked fetch ${url}`);
};
function setFetchRoutes(routes) { fetchRoutes = routes; fetchCallLog = []; }

const eventSources = [];
let activeEventSource = null;
class FakeEventSource {
  constructor(url) {
    this.url = url; this.onopen = null; this.onmessage = null; this.onerror = null; this.closed = false;
    eventSources.push(this); activeEventSource = this;
  }
  close() { this.closed = true; if (activeEventSource === this) activeEventSource = null; }
  send(event) { if (this.onmessage) this.onmessage({ data: JSON.stringify(event) }); }
  fireOpen() { if (this.onopen) this.onopen(); }
}
globalThis.EventSource = FakeEventSource;

function assistantText(item) {
  if (!item || item.role !== "assistant") return null;
  const t = item.blocks.find((b) => b.type === "text");
  return t ? t.text : null;
}

// ── Load the store under test. ──
const store = await import(transpileToDataUrl(`${process.cwd()}/frontend/src/lib/sessionStore.ts`));

function jobsFetchOk(runs = []) {
  return async () => ({ ok: true, json: async () => runs });
}
function jobsFetchFail() {
  return async () => ({ ok: false, json: async () => ({}) });
}
function messagesFetchOk(messages = []) {
  return async () => ({ ok: true, json: async () => messages });
}
function messagesFetchFail() {
  return async () => ({ ok: false, json: async () => ({}) });
}

const results = [];
function check(name, fn) {
  results.push({ name, fn });
}
async function runAll() {
  let failures = 0;
  for (const { name, fn } of results) {
    timeouts.length = 0; intervals.clear(); fetchRoutes = []; fetchCallLog = [];
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failures += 1; console.log(`FAIL  ${name}: ${e.message}`); }
  }
  return failures;
}

// ────────────────────────────────────────────────────────────────────────────
// Durable-entries store contract (SESSION-WIRE-PROTOCOL v2).
// ────────────────────────────────────────────────────────────────────────────

function eventsFetchOk(items = [], leafId = null, fromStart = true) {
  return async () => ({ ok: true, json: async () => ({ items, leafId, fromStart }) });
}
function eventsFetchFail() {
  return async () => ({ ok: false, json: async () => ({}) });
}

check("concurrent-load-dedup", async () => {
  const sid = "dedup";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([
      { id: "u1", parentId: null, timestamp: "2026-07-15T09:00:00.000Z", role: "user", text: "hi" },
      { id: "a1", parentId: "u1", timestamp: "2026-07-15T09:00:01.000Z", role: "assistant", blocks: [{ type: "text", text: "hello" }] },
    ], "a1") },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  const r2 = store.acquire(sid);
  await flushTimers();
  const items = store.getSnapshot(sid).items;
  assert.equal(items.length, 2, `concurrent loads must not duplicate transcript (got ${items.length})`);
  assert.equal(items[0].id, "u1", "stable entry ids from the projection");
  r1(); r2();
});

check("entries-merge-is-idempotent", async () => {
  const sid = "idem";
  const entries = [
    { id: "u1", parentId: null, timestamp: null, role: "user", text: "q" },
    { id: "a1", parentId: "u1", timestamp: null, role: "assistant", blocks: [{ type: "text", text: "a" }] },
  ];
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk(entries, "a1") },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  activeEventSource.send({ type: "entries", entries, leafId: "a1" });
  activeEventSource.send({ type: "entries", entries, leafId: "a1" });
  const items = store.getSnapshot(sid).items;
  assert.equal(items.length, 2, `duplicate batches must not duplicate items (got ${items.length})`);
  r1();
});

check("toolresult-entry-patches-tool-block", async () => {
  const sid = "toolres";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([
      { id: "u1", parentId: null, timestamp: null, role: "user", text: "run it" },
      { id: "a1", parentId: "u1", timestamp: null, role: "assistant", blocks: [
        { type: "toolCall", id: "call_1", name: "bash", args: { command: "echo hi" } },
      ] },
    ], "a1") },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  activeEventSource.send({ type: "entries", entries: [
    { id: "t1", parentId: "a1", timestamp: null, role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: false, text: "hi\n" },
    { id: "a2", parentId: "t1", timestamp: null, role: "assistant", blocks: [{ type: "text", text: "Done." }] },
  ], leafId: "a2" });
  const items = store.getSnapshot(sid).items;
  const turn = items.find((i) => i.id === "a1");
  const tool = turn.blocks.find((b) => b.type === "tool" && b.id === "call_1");
  assert.equal(tool.output, "hi\n", "toolResult entry patches the tool block output");
  assert.equal(tool.status, "done", "tool status becomes done");
  r1();
});

check("message-end-then-entries-replace-overlay", async () => {
  const sid = "overlay";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([
      { id: "u1", parentId: null, timestamp: null, role: "user", text: "q" },
    ], "u1") },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  activeEventSource.send({ type: "message_start", messageId: "m1" });
  activeEventSource.send({ type: "text_delta", messageId: "m1", delta: "partial" });
  let items = store.getSnapshot(sid).items;
  assert.equal(items.filter((i) => i.role === "assistant").length, 1, "live overlay bubble exists");
  activeEventSource.send({ type: "message_end", messageId: "m1" });
  activeEventSource.send({ type: "entries", entries: [
    { id: "a1", parentId: "u1", timestamp: null, role: "assistant", blocks: [{ type: "text", text: "partial and done" }] },
  ], leafId: "a1" });
  items = store.getSnapshot(sid).items;
  const bubbles = items.filter((i) => i.role === "assistant");
  assert.equal(bubbles.length, 1, "overlay replaced by durable entry, not duplicated");
  assert.equal(assistantText(bubbles[0]), "partial and done", "durable entry text wins");
  assert.equal(bubbles[0].id, "a1", "durable entry id adopted");
  r1();
});

check("multi-message-turn-reconnect-exact", async () => {
  const sid = "reconnect";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([], null) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  // Turn with two assistant messages; disk persisted message 1 already.
  activeEventSource.send({ type: "message_start", messageId: "m1" });
  activeEventSource.send({ type: "text_delta", messageId: "m1", delta: "first answer" });
  activeEventSource.send({ type: "message_end", messageId: "m1" });
  // Reconnect mid-second-message: sync replays disk (user + m1) + live overlay of m2 only.
  activeEventSource.send({ type: "sync", fromStart: true, entries: [
    { id: "u1", parentId: null, timestamp: null, role: "user", text: "q" },
    { id: "a1", parentId: "u1", timestamp: null, role: "assistant", blocks: [{ type: "text", text: "first answer" }] },
  ], leafId: "a1", streaming: true, live: { messageId: "m2", text: "second so far", thinking: "", tools: [] }, submissions: [] });
  const items = store.getSnapshot(sid).items;
  const bubbles = items.filter((i) => i.role === "assistant");
  assert.equal(bubbles.length, 2, "persisted first message + live second overlay");
  assert.equal(assistantText(bubbles[0]), "first answer");
  assert.equal(assistantText(bubbles[1]), "second so far", "overlay holds ONLY the in-flight message, no cross-message accumulation");
  r1();
});

check("optimistic-user-swap-keeps-display", async () => {
  const sid = "swap";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([], null) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
    { match: (u, o) => u.includes("/message") && o?.method === "POST", respond: async () => ({ ok: true, json: async () => ({ ok: true, submission: { id: "sub-1", prompt: "clean prompt", mode: "goal", status: "starting" } }) }) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  await store.send(sid, "clean prompt", "goal");
  await flushTimers();
  let items = store.getSnapshot(sid).items;
  assert.equal(items.filter((i) => i.role === "user").length, 1, "optimistic user bubble");
  // Persisted user entry carries the goal-wrapped text + submissionId annotation.
  activeEventSource.send({ type: "entries", entries: [
    { id: "u1", parentId: null, timestamp: null, role: "user", text: "You must use the create_goal tool … Task: clean prompt", submissionId: "sub-1" },
  ], leafId: "u1" });
  items = store.getSnapshot(sid).items;
  const users = items.filter((i) => i.role === "user");
  assert.equal(users.length, 1, "optimistic bubble swapped, not duplicated");
  assert.equal(users[0].id, "u1", "stable entry id adopted");
  assert.equal(users[0].content, "clean prompt", "raw prompt stays as the display text");
  assert.equal(users[0].submissionStatus, "starting", "submission status preserved through the swap");
  r1();
});

check("sync-replay-merges-after-cursor", async () => {
  const sid = "replay";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([
      { id: "u1", parentId: null, timestamp: null, role: "user", text: "one" },
      { id: "a1", parentId: "u1", timestamp: null, role: "assistant", blocks: [{ type: "text", text: "1" }] },
    ], "a1") },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  // Reconnect with a cursor: server sends only entries after the cursor.
  activeEventSource.send({ type: "sync", fromStart: false, entries: [
    { id: "u2", parentId: "a1", timestamp: null, role: "user", text: "two" },
  ], leafId: "u2", streaming: false, live: null, submissions: [] });
  const items = store.getSnapshot(sid).items;
  assert.equal(items.length, 3, `cursor replay appends without wiping history (got ${items.length})`);
  assert.equal(items[2].id, "u2");
  r1();
});

check("stream-closes-on-end-after-last-viewer", async () => {
  const sid = "close";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([], null) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  const es = activeEventSource;
  r1();
  es.send({ type: "end" });
  await flushTimers(); // closeTimer = 30s
  assert.equal(es.closed, true, "SSE closes 30s after end with no viewers");
});

check("queue-event-updates-count", async () => {
  const sid = "queuen";
  setFetchRoutes([
    { match: (u) => u.endsWith("/events"), respond: eventsFetchOk([], null) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  activeEventSource.send({ type: "queue", queued: 2 });
  assert.equal(store.getSnapshot(sid).queuedCount, 2);
  r1();
});

const failures = await runAll();
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall session stream/store regression checks passed");
