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
// Bug 1 (P1): concurrent loadHistory must not duplicate the transcript.
// ────────────────────────────────────────────────────────────────────────────
check("concurrent-load-dedup", async () => {
  const sid = "bug-1";
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([
      { role: "user", content: "hi", createdAt: "2026-07-15T09:00:00.000Z" },
      { role: "assistant", content: "hello", createdAt: "2026-07-15T09:00:01.000Z" },
    ]) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  const r2 = store.acquire(sid); // StrictMode double-mount before resolve
  await flushTimers();
  const items = store.getSnapshot(sid).items;
  assert.equal(items.length, 2, `concurrent loads must not duplicate transcript (got ${items.length})`);
  r1(); r2();
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 2 (P1): history prepend must not clear msgIndex for in-flight stream.
// ────────────────────────────────────────────────────────────────────────────
check("msgindex-survives-history-prepend", async () => {
  const sid = "bug-2";
  let releaseMessagesFetch;
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: () => new Promise((resolve) => {
      releaseMessagesFetch = () => resolve({
        ok: true,
        json: async () => [
          { role: "user", content: "earlier", createdAt: "2026-07-15T08:00:00.000Z" },
        ],
      });
    }) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await Promise.resolve();
  if (!activeEventSource) throw new Error("EventSource not opened");
  activeEventSource.fireOpen();
  activeEventSource.send({ type: "message_start", messageId: "m2", createdAt: "2026-07-15T09:00:05.000Z" });
  activeEventSource.send({ type: "text_delta", messageId: "m2", delta: "hello" });
  releaseMessagesFetch();
  await flushTimers();
  activeEventSource.send({ type: "text_delta", messageId: "m2", delta: " world" });
  const items = store.getSnapshot(sid).items;
  const bubbles = items.filter((i) => i.role === "assistant");
  assert.equal(bubbles.length, 1, "in-flight assistant bubble must not split across history prepend");
  assert.equal(assistantText(bubbles[0]), "hello world", "deltas must fold into the same bubble");
  r1();
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 3 (P2): reconnect sync must reconcile partialText into live bubble.
// ────────────────────────────────────────────────────────────────────────────
check("sync-partialText-reconcile", async () => {
  const sid = "bug-3";
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([]) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  activeEventSource.send({ type: "message_start", messageId: "m3", createdAt: "2026-07-15T09:00:00.000Z" });
  activeEventSource.send({ type: "text_delta", messageId: "m3", delta: "local-stale-" });
  // Reconnect sync arrives with authoritative partialText.
  activeEventSource.send({ type: "sync", streaming: true, partialText: "server-authoritative" });
  const items = store.getSnapshot(sid).items;
  const bubbles = items.filter((i) => i.role === "assistant");
  assert.equal(bubbles.length, 1, "no duplicate bubble after sync");
  assert.equal(assistantText(bubbles[0]), "server-authoritative", "sync partialText must replace stale local text");
  r1();
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 4 (P2): fresh join mid-turn must not render duplicate assistant bubble.
// ────────────────────────────────────────────────────────────────────────────
check("sync-bubble-adoption", async () => {
  const sid = "bug-4";
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([]) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  activeEventSource.fireOpen();
  // Fresh join: sync arrives first (no live bubble yet).
  activeEventSource.send({ type: "sync", streaming: true, partialText: "hi" });
  let items = store.getSnapshot(sid).items;
  let bubbles = items.filter((i) => i.role === "assistant");
  assert.equal(bubbles.length, 1, "sync creates one assistant bubble");
  // First real message_start must adopt the sync bubble.
  activeEventSource.send({ type: "message_start", messageId: "m4", createdAt: "2026-07-15T09:00:00.000Z" });
  activeEventSource.send({ type: "text_delta", messageId: "m4", delta: " there" });
  items = store.getSnapshot(sid).items;
  bubbles = items.filter((i) => i.role === "assistant");
  assert.equal(bubbles.length, 1, "real messageId must adopt the sync bubble, not append a second");
  assert.equal(assistantText(bubbles[0]), "hi there", "deltas fold into adopted bubble");
  r1();
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 5 (P2): failed history load must leave loaded=false so retry can refetch.
// ────────────────────────────────────────────────────────────────────────────
check("failed-load-allows-retry", async () => {
  const sid = "bug-5";
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchFail() },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  const stateAfterFail = store.getSnapshot(sid);
  assert.ok(stateAfterFail.error, "error banner shown after failed load");
  assert.equal(stateAfterFail.loaded, false, "loaded must remain false after failure so retry can refetch");
  // Now network heals.
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([
      { role: "user", content: "recovered", createdAt: "2026-07-15T09:00:00.000Z" },
    ]) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  await store.retry(sid);
  await flushTimers();
  const stateAfterRetry = store.getSnapshot(sid);
  assert.equal(stateAfterRetry.loaded, true, "retry refetches after a healed failure");
  assert.ok(stateAfterRetry.items.some((i) => i.role === "user" && i.content === "recovered"),
    "recovered history visible after retry");
  r1();
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 6 (P2): runPoll must be cleared on release (viewers=0) and after failures.
// ────────────────────────────────────────────────────────────────────────────
check("runPoll-cleared-on-release", async () => {
  const sid = "bug-6a";
  const runningRun = {
    id: "run-6a", submissionId: "sub-6a", runId: "r-6a", sessionId: sid, spaceId: "sp",
    description: "running", createdAt: "2026-07-15T09:00:00.000Z", lifecycle: "running",
    totalTasks: 1, checkedTasks: 0, passedTasks: 0, failedTasks: 0,
  };
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([]) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([runningRun]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  assert.ok(intervals.size >= 1, "runPoll interval registered while job is running");
  const before = intervals.size;
  r1();
  await flushTimers();
  assert.equal(intervals.size, before - 1, "runPoll interval cleared when last viewer releases");
});

check("runPoll-stops-after-failures", async () => {
  const sid = "bug-6b";
  const runningRun = {
    id: "run-6b", submissionId: "sub-6b", runId: "r-6b", sessionId: sid, spaceId: "sp",
    description: "running", createdAt: "2026-07-15T09:00:00.000Z", lifecycle: "running",
    totalTasks: 1, checkedTasks: 0, passedTasks: 0, failedTasks: 0,
  };
  // loadHistory sees a running job and starts polling; subsequent /jobs fetches fail.
  let jobsCallCount = 0;
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([]) },
    {
      match: (u) => u.endsWith("/hammersmith/jobs"),
      respond: async () => {
        jobsCallCount += 1;
        return jobsCallCount === 1 ? { ok: true, json: async () => [runningRun] } : { ok: false, json: async () => ({}) };
      },
    },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  assert.ok(intervals.size >= 1, "runPoll interval registered after seeing a running job");
  // Fire the interval until it clears itself (or hit a sane safety cap).
  let safety = 0;
  while (intervals.size > 0 && safety++ < 8) {
    for (const [, fn] of intervals) { await fn(); await flushMicrotasks(); break; }
  }
  assert.equal(intervals.size, 0, "runPoll cleared after bounded consecutive failures");
  r1();
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 7 (P3): SSE stream must close when the last viewer leaves mid-turn and turn ends.
// ────────────────────────────────────────────────────────────────────────────
check("stream-closes-on-end-after-last-viewer", async () => {
  const sid = "bug-7";
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([]) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  const es = activeEventSource;
  es.fireOpen();
  // Turn starts; viewer leaves mid-turn.
  es.send({ type: "submission", submission: { id: "sub-7", prompt: "go", mode: "message", status: "running" } });
  r1();
  await flushTimers();
  assert.ok(!es.closed, "while streaming, release must not close the stream");
  es.send({ type: "end" });
  await flushTimers();
  assert.ok(es.closed, "end after last viewer must close the stream");
});

// ────────────────────────────────────────────────────────────────────────────
// Bug 8 (P2): null-timestamp history items must keep disk order.
// ────────────────────────────────────────────────────────────────────────────
check("null-timestamps-keep-disk-order", async () => {
  const sid = "bug-8";
  // Disk order: user@t10, assistant@null, user@t20, user@null. Nulls must NOT bubble to top.
  setFetchRoutes([
    { match: (u) => u.endsWith("/messages"), respond: messagesFetchOk([
      { role: "user", content: "first", createdAt: "2026-07-15T09:00:10.000Z" },
      { role: "assistant", content: "second-legacy" },
      { role: "user", content: "third", createdAt: "2026-07-15T09:00:20.000Z" },
      { role: "user", content: "fourth-legacy" },
    ]) },
    { match: (u) => u.endsWith("/hammersmith/jobs"), respond: jobsFetchOk([]) },
  ]);
  const r1 = store.acquire(sid);
  await flushTimers();
  const items = store.getSnapshot(sid).items;
  const roles = items.map((i) => {
    if (i.role === "assistant") {
      const t = i.blocks.find((b) => b.type === "text");
      return `assistant:${t ? t.text : ""}`;
    }
    return `${i.role}:${i.content ?? ""}`;
  }).join(",");
  assert.equal(
    roles,
    "user:first,assistant:second-legacy,user:third,user:fourth-legacy",
    `null-timestamp items must preserve disk order (got ${roles})`,
  );
  r1();
});

const failures = await runAll();
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall session stream/store regression checks passed");
