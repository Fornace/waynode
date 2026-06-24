import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  getMessagesFromDisk,
  touchSession,
} from "../lib/sessions.mjs";
import { isPiAvailable } from "../lib/pi-runner.mjs";
import { readGoalStatus } from "../lib/pi-runner.mjs";
import { getAgent, getAgentIfActive } from "../lib/agent-manager.mjs";
import { config } from "../lib/config.mjs";

const router = Router();

// dev-token may arrive as header (fetch) or query (EventSource can't set headers)
function devToken(req) {
  return req.headers["x-dev-token"] || req.query.t;
}

// ── Session CRUD ──

router.get("/api/spaces/:spaceId/sessions", requireAuth, (req, res) => {
  res.json(listSessions(req.params.spaceId));
});

router.post("/api/spaces/:spaceId/sessions", requireAuth, (req, res) => {
  const { title, model, provider } = req.body;
  const session = createSession({
    spaceId: req.params.spaceId,
    userId: req.user.id,
    title,
    model: model || config.pi.defaultModel,
    provider: provider || config.pi.defaultProvider,
  });
  res.json(session);
});

function ownSession(req, res) {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (session.owner_id !== req.user.id) {
    res.status(403).json({ error: "Owner only" });
    return null;
  }
  return session;
}

router.get("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (session) res.json(session);
});

router.patch("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (session) res.json(updateSession(req.params.sessionId, req.body));
});

router.delete("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

// ── Messages (re-hydrated from pi JSONL on disk) ──

router.get("/api/sessions/:sessionId/messages", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (session) res.json(getMessagesFromDisk(session));
});

// ── Live event stream ──
// Long-lived SSE subscription to a session's agent. The agent process lives in
// the server-side AgentManager, so closing this connection (navigation, refresh)
// does NOT stop the agent — it keeps running and can be re-attached.

function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function writeSSE(res, ev) {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  } catch {}
}

router.get("/api/sessions/:sessionId/stream", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;

  if (!isPiAvailable()) {
    sseSetup(res);
    writeSSE(res, { type: "error", message: "pi is not installed on the server" });
    return res.end();
  }

  sseSetup(res);

  let handle;
  try {
    handle = await getAgent(session);
  } catch (err) {
    writeSSE(res, { type: "error", message: err.message });
    return res.end();
  }

  // Subscribe; subscribe() immediately emits a `sync` snapshot.
  const unsub = handle.subscribe((ev) => writeSSE(res, ev));

  const ping = setInterval(() => writeSSE(res, { type: "ping" }), 15000);
  req.on("close", () => {
    clearInterval(ping);
    unsub(); // detach this client only — agent keeps running
  });
});

// ── Send a message (fire-and-forget; events flow over /stream) ──

router.post("/api/sessions/:sessionId/message", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const { prompt, isGoal = false } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  if (!isPiAvailable()) return res.status(503).json({ error: "pi is not installed" });

  touchSession(session.id);

  let handle;
  try {
    handle = await getAgent(session);
  } catch (err) {
    return res.status(503).json({ error: "Failed to start agent: " + err.message });
  }

  // Busy: client should queue a follow-up instead.
  if (handle.streaming) return res.status(409).json({ error: "busy" });

  handle
    .sendPrompt(prompt, isGoal)
    .catch((err) => handle.broadcast({ type: "error", message: err.message }));

  res.json({ ok: true });
});

// ── Queue a follow-up while a turn is running ──

router.post("/api/sessions/:sessionId/queue", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const handle = getAgentIfActive(session.id);
  if (handle?.streaming) {
    handle.queueFollowUp(prompt);
    return res.json({ ok: true, queued: true });
  }

  // Not currently streaming — send directly.
  try {
    const h = handle || (await getAgent(session));
    h.sendPrompt(prompt, false).catch((err) => h.broadcast({ type: "error", message: err.message }));
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// ── Abort the current turn (agent stays alive) ──

router.post("/api/sessions/:sessionId/abort", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const handle = getAgentIfActive(session.id);
  if (handle) await handle.abort();
  res.json({ ok: true });
});

// ── Live state (is something running?) ──

router.get("/api/sessions/:sessionId/state", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const handle = getAgentIfActive(session.id);
  res.json({ active: !!(handle && handle.streaming), done: !(handle && handle.streaming) });
});

// ── Goal status (pi-codex-goal plugin) ──

router.get("/api/sessions/:sessionId/goal", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  res.json({ goal: readGoalStatus(session.pi_session_dir) });
});

export default router;
