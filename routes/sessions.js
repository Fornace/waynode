import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, requireSpaceAccess, queryTokenAuth } from "../lib/auth.mjs";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  archiveSession,
  getMessagesFromDisk,
  touchSession,
} from "../lib/sessions.mjs";
import { isPiAvailable } from "../lib/pi-runner.mjs";
import { readGoalStatus } from "../lib/pi-runner.mjs";
import { getAgent, getAgentIfActive } from "../lib/agent-manager.mjs";
import { config } from "../lib/config.mjs";
import { getSpace } from "../lib/spaces.mjs";
import { getOrgSetting } from "../lib/orgs.mjs";
import { billingEnabled } from "../lib/config.mjs";
import {
  checkQuota,
  finishTokenReservation,
  releaseTokenReservation,
  reserveTokenQuota,
} from "../lib/billing.mjs";
import { refreshOrgStorageUsage } from "../lib/storage-quota.mjs";
import { configuredModelCatalog, resolvePiModel } from "../lib/pi-model.mjs";

const router = Router();

// sseAuth in routes/spaces.js and routes/git.js. Without this, the /stream
// SSE route 401s for every dev-token client, since EventSource can't send
// the x-dev-token header requireAuth checks.
function sseAuth(req, res, next) {
  const user = queryTokenAuth(req);
  if (user) {
    req.user = user;
    req.isAuthenticated = () => true;
    return next();
  }
  requireAuth(req, res, next);
}

// ── Session CRUD ──

router.get("/api/spaces/:spaceId/sessions", requireAuth, requireSpaceAccess, (req, res) => {
  const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
  res.json(listSessions(req.params.spaceId, { includeArchived }));
});

router.post("/api/spaces/:spaceId/sessions", requireAuth, requireSpaceAccess, (req, res) => {
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only role" });
  const { title, model, provider } = req.body;

  // Precedence: explicit request body > org's default_model setting > global env default.
  const space = getSpace(req.params.spaceId);
  const orgDefaultModel = space?.org_id ? getOrgSetting(space.org_id, "default_model") : null;
  const validDefault = configuredModelCatalog().some((entry) => entry.id === orgDefaultModel)
    ? orgDefaultModel
    : config.pi.defaultModel;

  const selection = resolvePiModel({
    provider: provider || config.pi.defaultProvider,
    model: model || validDefault,
  });
  const session = createSession({
    spaceId: req.params.spaceId,
    userId: req.user.id,
    title,
    model: selection.model,
    provider: selection.provider,
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

// Self-hosted deployments never enforce Waynode Cloud plans. In hosted mode,
// gate a new model turn before the agent starts so expired trials and dunning
// accounts cannot keep consuming provider spend. Usage is metered at turn end;
// this preflight deliberately protects the next turn rather than pretending to
// predict its token cost.
function canUseHostedWorkspace(session, res) {
  if (!billingEnabled) return true;
  const space = getSpace(session.space_id);
  if (!space?.org_id) return true;
  const quota = checkQuota(space.org_id);
  if (!['active', 'trialing'].includes(quota.status)) {
    res.status(402).json({ error: 'Your Waynode Cloud trial or subscription is not active. Update billing to continue.' });
    return false;
  }
  return true;
}

function reserveHostedTurn(session, res) {
  if (!canUseHostedWorkspace(session, res)) return { allowed: false };
  if (!billingEnabled) return { allowed: true, orgId: null, reservation: null };
  const space = getSpace(session.space_id);
  if (!space?.org_id) return { allowed: true, orgId: null, reservation: null };
  try {
    const reservation = reserveTokenQuota(space.org_id, `turn:${randomUUID()}`);
    return { allowed: true, orgId: space.org_id, reservation };
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status === 402
        ? error.message
        : "Agent usage could not be reserved. Try again.",
    });
    return { allowed: false };
  }
}

function reconcileHostedTurn(admission) {
  if (!admission?.reservation) return;
  finishTokenReservation(admission.reservation.id);
  refreshOrgStorageUsage(admission.orgId).catch((error) => {
    console.error("[agent storage] refresh failed:", error.message);
  });
}

function requestSubmission(req) {
  const supplied = req.body?.submissionId;
  const id = typeof supplied === "string" && supplied.length > 0 && supplied.length <= 128
    ? supplied
    : randomUUID();
  return { id, prompt: req.body?.prompt, isGoal: !!req.body?.isGoal };
}

function existingSubmission(handle, id) {
  return handle?.getSubmission?.(id) || null;
}

router.get("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (session) res.json(session);
});

router.patch("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (session) res.json(updateSession(req.params.sessionId, req.body));
});

// Switch the model and push it to the LIVE agent. Unlike a generic PATCH
// (which only persists to the DB for the next spawn), this also sends pi's RPC
// `set_model` command to a running agent so the change takes effect
// immediately on the next LLM call. If no agent process is currently alive,
// the DB write is enough — getAgent() will spawn with the new model on demand.
router.post("/api/sessions/:sessionId/model", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const { model, provider } = req.body;
  if (!model || typeof model !== "string") return res.status(400).json({ error: "model required" });

  let selection;
  try {
    selection = resolvePiModel({ provider: provider || session.provider, model });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const handle = getAgentIfActive(session.id);
  if (handle) {
    // Validate against the LIVE agent first: if it rejects the model, return 400
    // WITHOUT touching the DB, so the stored model and the running process never
    // desync. (When no agent is running, there's nothing to validate against —
    // the next spawn will catch an unknown id.)
    try {
      await handle.setModel(selection.provider, selection.model);
    } catch (err) {
      return res.status(400).json({ error: `Model not applied: ${err.message}` });
    }
  }

  updateSession(session.id, { model: selection.model, provider: selection.provider });
  res.json({ ok: true, model: selection.model, provider: selection.provider, live: !!handle });
});

router.delete("/api/sessions/:sessionId", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

router.post("/api/sessions/:sessionId/archive", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const { archived = true } = req.body || {};
  res.json(archiveSession(session.id, !!archived));
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

router.get("/api/sessions/:sessionId/stream", sseAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  if (!canUseHostedWorkspace(session, res)) return;

  if (!isPiAvailable()) {
    sseSetup(res);
    writeSSE(res, { type: "error", message: "pi is not installed on the server" });
    return res.end();
  }

  sseSetup(res);
  // Send a body frame immediately. Some reverse tunnels do not expose an
  // EventSource as open when they have only received response headers, which
  // leaves clients visually stuck on “Connecting…” while pi starts normally.
  writeSSE(res, { type: "connecting" });

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
  const { id: submissionId, prompt, isGoal } = requestSubmission(req);
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  if (!isPiAvailable()) return res.status(503).json({ error: "pi is not installed" });
  const duplicate = existingSubmission(getAgentIfActive(session.id), submissionId);
  if (duplicate) return res.json({ ok: true, submission: duplicate, duplicate: true });
  const admission = reserveHostedTurn(session, res);
  if (!admission.allowed) return;

  touchSession(session.id);

  let handle;
  try {
    handle = await getAgent(session);
  } catch (err) {
    releaseTokenReservation(admission.reservation?.id);
    return res.status(503).json({ error: "Failed to start agent: " + err.message });
  }

  // Busy: client should queue a follow-up instead.
  if (handle.streaming) {
    releaseTokenReservation(admission.reservation?.id);
    return res.status(409).json({ error: "busy" });
  }

  const completion = handle
    .sendPrompt(prompt, isGoal, submissionId)
    .catch((err) => handle.broadcast({ type: "error", message: err.message }))
    .finally(() => reconcileHostedTurn(admission));

  void completion;
  res.json({ ok: true, submission: handle.getSubmission(submissionId) });
});

// ── Queue a follow-up while a turn is running ──

router.post("/api/sessions/:sessionId/queue", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const { id: submissionId, prompt, isGoal } = requestSubmission(req);
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const activeHandle = getAgentIfActive(session.id);
  const duplicate = existingSubmission(activeHandle, submissionId);
  if (duplicate) return res.json({ ok: true, submission: duplicate, duplicate: true });
  const admission = reserveHostedTurn(session, res);
  if (!admission.allowed) return;

  const handle = activeHandle;
  if (handle?.streaming) {
    try {
      handle.queueFollowUp(prompt, isGoal, submissionId)
        .catch((error) => handle.broadcast({ type: "error", message: error.message }))
        .finally(() => reconcileHostedTurn(admission));
    } catch (error) {
      releaseTokenReservation(admission.reservation?.id);
      return res.status(error.status || 409).json({
        error: error.message,
        submission: { id: submissionId, prompt, isGoal, status: "failed", error: error.message },
      });
    }
    return res.json({ ok: true, queued: true, submission: handle.getSubmission(submissionId) });
  }

  // Not currently streaming — send directly.
  try {
    const h = handle || (await getAgent(session));
    h.sendPrompt(prompt, isGoal, submissionId)
      .catch((err) => h.broadcast({ type: "error", message: err.message }))
      .finally(() => reconcileHostedTurn(admission));
    res.json({ ok: true, submission: h.getSubmission(submissionId) });
  } catch (err) {
    releaseTokenReservation(admission.reservation?.id);
    res.status(503).json({ error: err.message });
  }
});

// ── Abort the current turn (agent stays alive) ──

router.post("/api/sessions/:sessionId/abort", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const handle = getAgentIfActive(session.id);
  const result = handle ? await handle.abort() : { cancelled: false };
  res.json({ ok: true, ...result });
});

// ── Live state (is something running?) ──

router.get("/api/sessions/:sessionId/state", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  const handle = getAgentIfActive(session.id);
  res.json({
    active: !!(handle && handle.streaming),
    done: !(handle && handle.streaming),
    submissions: handle?.getSubmissionSnapshot?.() || [],
  });
});

// ── Goal status (pi-codex-goal plugin) ──

router.get("/api/sessions/:sessionId/goal", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  res.json({ goal: readGoalStatus(session.pi_session_dir) });
});

export default router;
