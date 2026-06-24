import { Router } from "express";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import {
  createSession, getSession, listSessions, updateSession, deleteSession,
  addMessage, getMessages, autoTitle,
  createActiveChat, getActiveChat, completeActiveChat, removeActiveChat,
  activeChats,
} from "../lib/sessions.mjs";
import { runPiMessage, isPiAvailable } from "../lib/pi-runner.mjs";
import { config } from "../lib/config.mjs";

const router = Router();

router.get("/api/spaces/:spaceId/sessions", requireAuth, requireSpaceAccess, (req, res) => {
  res.json(listSessions(req.params.spaceId));
});

router.post("/api/spaces/:spaceId/sessions", requireAuth, requireSpaceAccess, (req, res) => {
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

router.get("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json(session);
});

router.patch("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });
  const updated = updateSession(req.params.sessionId, req.body);
  res.json(updated);
});

router.delete("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });
  deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

router.get("/api/sessions/:sessionId/messages", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });
  res.json(getMessages(req.params.sessionId));
});

// ── Send message — spawns pi, streams SSE, buffers chunks ──

router.post("/api/sessions/:sessionId/message", requireAuth, async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const { prompt, isGoal = false } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  if (!isPiAvailable()) {
    return res.status(503).json({
      error: "pi is not installed on this server",
      hint: "Install pi CLI, then restart the container",
    });
  }

  addMessage({ sessionId: session.id, role: "user", content: prompt, isGoal });
  autoTitle(session.id);

  // Create active chat session with chunk buffering
  const chat = createActiveChat({ sessionId: session.id, userId: req.user.id });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (type, data) => {
    const payload = JSON.stringify({ type, ...data });
    res.write(`data: ${payload}\n\n`);
    chat.chunks.push(`data: ${payload}\n\n`);
    chat.updatedAt = Date.now();
  };

  // Heartbeat keeps connection alive (like adsmanager)
  const heartbeat = setInterval(() => {
    if (!res.destroyed) {
      try { res.write(": ping\n\n"); } catch {}
    } else {
      clearInterval(heartbeat);
    }
  }, 15000);

  try {
    send("start", { isGoal });

    const child = runPiMessage({ session, prompt, isGoal });
    chat.ac.signal.addEventListener("abort", () => {
      if (!child.killed) child.kill("SIGTERM");
    });

    let fullResponse = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      fullResponse += text;
      chat.assistantContent += text;
      send("delta", { text });
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      send("stderr", { text });
    });

    child.on("close", (code) => {
      clearInterval(heartbeat);
      if (fullResponse.trim()) {
        addMessage({ sessionId: session.id, role: "assistant", content: fullResponse });
      }
      send("done", { exitCode: code });
      completeActiveChat(session.id);
      updateSession(session.id, {});
      try { res.write("data: [DONE]\n\n"); } catch {}
      try { res.end(); } catch {}
      // Keep chat in memory for resume, clean up after 5 min
      setTimeout(() => removeActiveChat(session.id), 5 * 60 * 1000);
    });

    child.on("error", (err) => {
      clearInterval(heartbeat);
      send("error", { message: err.message });
      completeActiveChat(session.id);
      try { res.end(); } catch {}
    });

    // Client disconnect — pi keeps running, chat stays buffered
    req.on("close", () => {
      clearInterval(heartbeat);
      // Don't kill pi — it keeps running server-side
      // Just stop writing to this response
      if (!res.destroyed) {
        try { res.end(); } catch {}
      }
    });
  } catch (err) {
    clearInterval(heartbeat);
    send("error", { message: err.message });
    completeActiveChat(session.id);
    try { res.end(); } catch {}
  }
});

// ── Resume a detached chat session ──

router.get("/api/sessions/:sessionId/resume", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const chat = getActiveChat(session.id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (!chat) {
    // No active chat — return persisted messages
    return res.json({
      active: false,
      messages: getMessages(session.id),
    });
  }

  // Replay buffered chunks
  for (const chunk of chat.chunks) {
    if (res.destroyed) return;
    try { res.write(chunk); } catch { return; }
  }

  if (chat.done) {
    try { res.write("data: [DONE]\n\n"); } catch {}
    try { res.end(); } catch {}
    return;
  }

  // Continue streaming new chunks
  const heartbeat = setInterval(() => {
    if (!res.destroyed) try { res.write(": ping\n\n"); } catch {}
    else clearInterval(heartbeat);
  }, 15000);

  let replayed = chat.chunks.length;
  const poller = setInterval(() => {
    if (res.destroyed) {
      clearInterval(poller);
      clearInterval(heartbeat);
      return;
    }
    while (replayed < chat.chunks.length) {
      try { res.write(chat.chunks[replayed++]); } catch {
        clearInterval(poller);
        clearInterval(heartbeat);
        return;
      }
    }
    if (chat.done) {
      clearInterval(poller);
      clearInterval(heartbeat);
      try { res.write("data: [DONE]\n\n"); } catch {}
      try { res.end(); } catch {}
    }
  }, 200);
});

// ─ Abort an active chat session ──

router.post("/api/sessions/:sessionId/abort", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const chat = getActiveChat(session.id);
  if (chat && !chat.done) {
    chat.ac.abort();
    chat.aborted = true;
    completeActiveChat(session.id);
    res.json({ ok: true, aborted: true });
  } else {
    res.json({ ok: true, aborted: false });
  }
});

// ── Queue a follow-up message (steer the conversation while pi is running) ──

router.post("/api/sessions/:sessionId/queue", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const chat = getActiveChat(session.id);
  if (!chat || chat.done) {
    return res.status(409).json({ error: "No active chat to queue into" });
  }

  // Store queued message — will be sent after current pi turn completes
  if (!chat.queued) chat.queued = [];
  chat.queued.push(prompt);

  res.json({ ok: true, position: chat.queued.length });
});

// ── Get active session state ──

router.get("/api/sessions/:sessionId/state", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const chat = getActiveChat(session.id);
  if (!chat) {
    return res.json({ active: false, done: true });
  }

  res.json({
    active: !chat.done,
    done: chat.done,
    aborted: chat.aborted,
    assistantContent: chat.assistantContent,
    startedAt: chat.startedAt,
    updatedAt: chat.updatedAt,
    chunkCount: chat.chunks.length,
  });
});

router.get("/api/sessions/:sessionId/goal", requireAuth, async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  try {
    const { readGoalStatus } = await import("../lib/pi-runner.mjs");
    const status = readGoalStatus(session.pi_session_dir);
    res.json({ goal: status });
  } catch {
    res.json({ goal: null });
  }
});

export default router;
