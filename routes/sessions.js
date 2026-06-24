import { Router } from "express";
import { Readable } from "node:stream";
import { pipeUIMessageStreamToResponse } from "ai";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import {
  createSession, getSession, listSessions, updateSession, deleteSession,
  addMessage, getMessages, autoTitle,
  createActiveChat, getActiveChat, completeActiveChat, removeActiveChat,
} from "../lib/sessions.mjs";
import { isPiAvailable, runPiMessage } from "../lib/pi-runner.mjs";
import { createChatStream, isLLMConfigured } from "../lib/llm-runner.mjs";
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
    model: model || config.llm.model,
    provider,
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
  res.json(updateSession(req.params.sessionId, req.body));
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

// ── Send message — Vercel AI SDK streaming (same as adsmanager) ──

router.post("/api/sessions/:sessionId/message", requireAuth, async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const { prompt, isGoal = false } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const piReady = isPiAvailable();
  const llmReady = isLLMConfigured();

  if (!piReady && !llmReady) {
    return res.status(503).json({ error: "No chat engine configured" });
  }

  addMessage({ sessionId: session.id, role: "user", content: prompt, isGoal });
  autoTitle(session.id);

  const chat = createActiveChat({ sessionId: session.id, userId: req.user.id });

  if (piReady) {
    // ── pi CLI mode (spawn child process, stream stdout) ──
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    const heartbeat = setInterval(() => { if (!res.destroyed) try { res.write(": ping\n\n"); } catch {} }, 15000);

    try {
      send("start", { isGoal, engine: "pi" });
      const child = runPiMessage({ session, prompt, isGoal });
      chat.ac.signal.addEventListener("abort", () => { if (!child.killed) child.kill("SIGTERM"); });

      let fullResponse = "";
      child.stdout.on("data", (chunk) => { const text = chunk.toString(); fullResponse += text; send("delta", { text }); });
      child.stderr.on("data", (chunk) => send("stderr", { text: chunk.toString() }));
      child.on("close", (code) => {
        clearInterval(heartbeat);
        if (fullResponse.trim()) addMessage({ sessionId: session.id, role: "assistant", content: fullResponse });
        send("done", { exitCode: code });
        completeActiveChat(session.id);
        updateSession(session.id, {});
        try { res.write("data: [DONE]\n\n"); } catch {}
        try { res.end(); } catch {}
        setTimeout(() => removeActiveChat(session.id), 5 * 60 * 1000);
      });
      child.on("error", (err) => { clearInterval(heartbeat); send("error", { message: err.message }); try { res.end(); } catch {} });
      req.on("close", () => { clearInterval(heartbeat); if (!res.destroyed) try { res.end(); } catch {} });
    } catch (err) { clearInterval(heartbeat); send("error", { message: err.message }); try { res.end(); } catch {} }
    return;
  }

  // ── LLM mode: Vercel AI SDK streamText → pipeUIMessageStreamToResponse ──
  let assistantContent = "";

  try {
    const stream = await createChatStream({
      session,
      prompt,
      abortSignal: chat.ac.signal,
      onFinish: ({ messages }) => {
        const last = messages[messages.length - 1];
        if (last?.parts) {
          assistantContent = last.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
        }
      },
    });

    pipeUIMessageStreamToResponse({
      response: res,
      stream,
      consumeSseStream: async ({ stream: sseStream }) => {
        try { await drainStream(sseStream); } catch {}
        if (assistantContent.trim()) {
          addMessage({ sessionId: session.id, role: "assistant", content: assistantContent });
        }
        completeActiveChat(session.id);
        updateSession(session.id, {});
        setTimeout(() => removeActiveChat(session.id), 5 * 60 * 1000);
      },
    });

    req.on("close", () => {
      chat.ac.abort();
    });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "LLM unreachable", detail: String(e).slice(0, 300) });
    else try { res.end(); } catch {}
  }
});

async function drainStream(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// ── Resume ──

router.get("/api/sessions/:sessionId/resume", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const chat = getActiveChat(session.id);
  if (!chat || chat.done) {
    return res.json({ active: false, messages: getMessages(session.id) });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  for (const chunk of chat.chunks) {
    if (res.destroyed) return;
    try { res.write(chunk); } catch { return; }
  }
  if (chat.done) { try { res.write("data: [DONE]\n\n"); } catch {} try { res.end(); } catch {} return; }

  const heartbeat = setInterval(() => { if (!res.destroyed) try { res.write(": ping\n\n"); } catch {} }, 15000);
  let replayed = chat.chunks.length;
  const poller = setInterval(() => {
    if (res.destroyed) { clearInterval(poller); clearInterval(heartbeat); return; }
    while (replayed < chat.chunks.length) { try { res.write(chat.chunks[replayed++]); } catch { clearInterval(poller); clearInterval(heartbeat); return; } }
    if (chat.done) { clearInterval(poller); clearInterval(heartbeat); try { res.write("data: [DONE]\n\n"); } catch {} try { res.end(); } catch {} }
  }, 200);
});

// ── Abort ──

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

// ── Queue (steer) ──

router.post("/api/sessions/:sessionId/queue", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const chat = getActiveChat(session.id);
  if (!chat || chat.done) return res.status(409).json({ error: "No active chat" });

  if (!chat.queued) chat.queued = [];
  chat.queued.push(prompt);
  res.json({ ok: true, position: chat.queued.length });
});

// ── State ──

router.get("/api/sessions/:sessionId/state", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  const chat = getActiveChat(session.id);
  res.json({
    active: chat && !chat.done,
    done: !chat || chat.done,
    aborted: chat?.aborted,
  });
});

// ── Goal ──

router.get("/api/sessions/:sessionId/goal", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  try {
    const { readGoalStatus } = require("../lib/pi-runner.mjs");
    res.json({ goal: readGoalStatus(session.pi_session_dir) });
  } catch { res.json({ goal: null }); }
});

export default router;
