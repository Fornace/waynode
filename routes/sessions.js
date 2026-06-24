import { Router } from "express";
import { Readable } from "node:stream";
import { pipeUIMessageStreamToResponse } from "ai";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import {
  createSession, getSession, listSessions, updateSession, deleteSession,
  getMessagesFromDisk, touchSession,
} from "../lib/sessions.mjs";
import { isPiAvailable, runPiMessageSync } from "../lib/pi-runner.mjs";
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
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });
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

// ── Messages from pi JSONL on disk ──

router.get("/api/sessions/:sessionId/messages", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });
  res.json(getMessagesFromDisk(session));
});

// ── Send message ──

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

  touchSession(session.id);

  if (piReady) {
    // ── pi CLI mode ──
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const send = (type, data) => {
      const payload = JSON.stringify({ type, ...data });
      res.write(`data: ${payload}\n\n`);
      if (typeof res.flush === "function") res.flush();
    };

    try {
      send("start", { isGoal, engine: "pi" });

      const result = runPiMessageSync({ session, prompt, isGoal });

      if (result.stdout.trim()) {
        send("delta", { text: result.stdout });
      }
      if (result.stderr.trim()) {
        console.error("[pi] stderr:", result.stderr.slice(0, 200));
        send("stderr", { text: result.stderr });
      }

      send("done", { exitCode: result.status });
      touchSession(session.id);
      try { res.write("data: [DONE]\n\n"); } catch {}
      try { res.end(); } catch {}
    } catch (err) {
      console.error("[pi] error:", err.message);
      send("error", { message: err.message });
      try { res.end(); } catch {}
    }
    return;
  }

  // ── LLM mode: Vercel AI SDK ──
  try {
    const stream = await createChatStream({
      session,
      prompt,
      abortSignal: req.signal,
    });

    pipeUIMessageStreamToResponse({
      response: res,
      stream,
      consumeSseStream: async ({ stream: sseStream }) => {
        try { await drainStream(sseStream); } catch {}
        touchSession(session.id);
      },
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

// ── Abort ──

router.post("/api/sessions/:sessionId/abort", requireAuth, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });
  res.json({ ok: true });
});

export default router;
