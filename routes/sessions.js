import { Router } from "express";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import {
  createSession, getSession, listSessions, updateSession, deleteSession,
  addMessage, getMessages, autoTitle,
} from "../lib/sessions.mjs";
import { runPiMessage, isPiAvailable } from "../lib/pi-runner.mjs";
import { config } from "../lib/config.mjs";
import { createHash } from "crypto";

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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const msgId = createHash("md5").update(`${session.id}-${Date.now()}`).digest("hex").slice(0, 8);

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data, msgId })}\n\n`);
  };

  try {
    send("start", { isGoal });

    const child = runPiMessage({ session, prompt, isGoal });

    let buffer = "";
    let fullResponse = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        fullResponse += line + "\n";
        send("delta", { text: line + "\n" });
      }
    });

    child.stderr.on("data", (chunk) => {
      send("stderr", { text: chunk.toString() });
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        fullResponse += buffer + "\n";
        send("delta", { text: buffer + "\n" });
      }
      if (fullResponse.trim()) {
        addMessage({ sessionId: session.id, role: "assistant", content: fullResponse });
      }
      send("done", { exitCode: code });
      updateSession(session.id, {});
      res.end();
    });

    child.on("error", (err) => {
      send("error", { message: err.message });
      res.end();
    });

    req.on("close", () => {
      if (!child.killed) child.kill("SIGTERM");
    });
  } catch (err) {
    send("error", { message: err.message });
    res.end();
  }
});

router.get("/api/sessions/:sessionId/goal", requireAuth, async (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" });

  try {
    const { readGoalStatus } = await import("../lib/pi-runner.mjs");
    const status = await readGoalStatus(session.pi_session_dir);
    res.json({ goal: status });
  } catch {
    res.json({ goal: null });
  }
});

export default router;
