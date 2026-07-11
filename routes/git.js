/**
 * routes/git.js — git sidebar API for a space.
 *
 *  GET    /api/spaces/:spaceId/git               full snapshot (+ piBusy flag)
 *  GET    /api/spaces/:spaceId/git/sse           live SSE: pushes snapshot when it changes (poll ~5s)
 *  GET    /api/spaces/:spaceId/git/diff?path=    inline diff for one file
 *  POST   /api/spaces/:spaceId/git/commit        { files, summary, description }
 *  POST   /api/spaces/:spaceId/git/switch-branch { branchName, mode: 'stash'|'carry'|'clean' }
 *  POST   /api/spaces/:spaceId/git/create-branch { branchName, baseBranch }
 *  POST   /api/spaces/:spaceId/git/pull          fast-forward only
 *
 * The user is the owner of the repo; pi being busy is surfaced as `piBusy`
 * (informational) and never hard-blocks writes here — the UI soft-warns.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, requireSpaceAccess, queryTokenAuth } from "../lib/auth.mjs";
import { getSpace } from "../lib/spaces.mjs";
import { isSpaceBusy } from "../lib/agent-manager.mjs";
import * as git from "../lib/git-ops.mjs";
import { identityForUser } from "../lib/git-identity.mjs";
import { config } from "../lib/config.mjs";
import db from "../lib/db.mjs";

const router = Router();

function spacePath(req) {
  const space = getSpace(req.params.spaceId);
  return space?.local_path || null;
}

// Shared error mapper: a space row can outlive its on-disk directory (deleted
// outside the app, or a stale/orphaned row). git-ops throws a tagged
// SpaceDirMissingError for this case (see lib/git-ops.mjs) instead of letting
// git's raw "fatal: cannot change to '...'" stderr propagate as a 500.
function sendGitError(res, e, fallbackStatus = 500) {
  if (e.spaceDirMissing) return res.status(409).json({ error: e.message, spaceDirMissing: true });
  return res.status(fallbackStatus).json({ error: e.message });
}

// Snapshot (REST)
router.get("/api/spaces/:spaceId/git", requireAuth, requireSpaceAccess, (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found" });
  try {
    const data = git.getSnapshot(cwd);
    data.piBusy = isSpaceBusy(req.params.spaceId);
    res.json(data);
  } catch (e) {
    sendGitError(res, e);
  }
});

// Single-file diff
router.get("/api/spaces/:spaceId/git/diff", requireAuth, requireSpaceAccess, (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found" });
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: "path required" });
  try {
    const diff = git.getFileDiff(cwd, path);
    res.json({ path, diff });
  } catch (e) {
    sendGitError(res, e);
  }
});

// ── SSE live stream ──
// EventSource can't set headers, so the dev token comes through ?t=.
function sseAuth(req, res, next) {
  const user = queryTokenAuth(req);
  if (user) {
    req.user = user;
    req.isAuthenticated = () => true;
    return next();
  }
  requireAuth(req, res, next);
}

function writeSSE(res, ev) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (typeof res.flush === "function") res.flush();
}

router.get("/api/spaces/:spaceId/git/sse", sseAuth, requireSpaceAccess, (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).end();
  const spaceId = req.params.spaceId;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  let lastSig = "";
  const poll = () => {
    try {
      const data = git.getSnapshot(cwd);
      data.piBusy = isSpaceBusy(spaceId);
      const sig = JSON.stringify(data);
      if (sig !== lastSig) {
        lastSig = sig;
        writeSSE(res, { type: "snapshot", data });
      }
    } catch (e) {
      writeSSE(res, { type: "error", message: e.message, spaceDirMissing: !!e.spaceDirMissing });
      // The directory isn't coming back on its own — stop hammering it every
      // 5s with a doomed git invocation.
      if (e.spaceDirMissing) clearInterval(interval);
    }
  };
  poll(); // immediate
  const interval = setInterval(poll, 5000);
  const ping = setInterval(() => writeSSE(res, { type: "ping" }), 25000);
  req.on("close", () => {
    clearInterval(interval);
    clearInterval(ping);
  });
});

// ── Writes ──
router.post("/api/spaces/:spaceId/git/commit", requireAuth, requireSpaceAccess, async (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found" });
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only role" });
  try {
    await git.commitSelected(cwd, { ...req.body || {}, identity: identityForUser(req.user) });
    const data = git.getSnapshot(cwd);
    data.piBusy = isSpaceBusy(req.params.spaceId);
    res.json({ ok: true, data });
  } catch (e) {
    sendGitError(res, e, 400);
  }
});

router.post("/api/spaces/:spaceId/git/switch-branch", requireAuth, requireSpaceAccess, async (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found" });
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only role" });
  try {
    await git.switchBranch(cwd, req.body || {});
    const data = git.getSnapshot(cwd);
    data.piBusy = isSpaceBusy(req.params.spaceId);
    res.json({ ok: true, data });
  } catch (e) {
    sendGitError(res, e, 400);
  }
});

router.post("/api/spaces/:spaceId/git/create-branch", requireAuth, requireSpaceAccess, async (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found" });
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only role" });
  try {
    await git.createBranch(cwd, req.body || {});
    const data = git.getSnapshot(cwd);
    data.piBusy = isSpaceBusy(req.params.spaceId);
    res.json({ ok: true, data });
  } catch (e) {
    sendGitError(res, e, 400);
  }
});

router.post("/api/spaces/:spaceId/git/pull", requireAuth, requireSpaceAccess, async (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found" });
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only role" });
  const mode = req.body?.mode || "ff-only";
  try {
    const result = await git.pull(cwd, { mode, identity: identityForUser(req.user) });
    const data = git.getSnapshot(cwd);
    data.piBusy = isSpaceBusy(req.params.spaceId);
    res.json({ ok: true, mode: result.mode, output: result.output, aborted: result.aborted, conflicts: result.conflicts, data });
  } catch (e) {
    // Divergence is not a hard failure — tell the UI it needs a choice.
    if (e.diverged) return res.status(409).json({ error: e.message, diverged: true });
    sendGitError(res, e, 400);
  }
});

router.post("/api/spaces/:spaceId/git/push", requireAuth, requireSpaceAccess, async (req, res) => {
  const operationId = randomUUID().slice(0, 8);
  res.setHeader("X-Waynode-Operation-Id", operationId);
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found", operationId });
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only role", operationId });
  console.info(`[git:push:${operationId}] start space=${req.params.spaceId} user=${req.user.id} upstream=${!!req.body?.setUpstream}`);
  try {
    const result = await git.push(cwd, { setUpstream: !!req.body?.setUpstream });
    const data = git.getSnapshot(cwd);
    data.piBusy = isSpaceBusy(req.params.spaceId);
    console.info(`[git:push:${operationId}] success space=${req.params.spaceId}`);
    res.json({ ok: true, pushed: result.pushed, data, operationId });
  } catch (e) {
    console.warn(`[git:push:${operationId}] failed space=${req.params.spaceId} reason=${e.message}`);
    if (e.spaceDirMissing) return sendGitError(res, e);
    res.status(400).json({ error: e.message, pushRejected: !!e.pushRejected, noUpstream: !!e.noUpstream, operationId });
  }
});

router.post("/api/spaces/:spaceId/git/merge", requireAuth, requireSpaceAccess, async (req, res) => {
  const cwd = spacePath(req);
  if (!cwd) return res.status(404).json({ error: "Space not found" });
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only role" });
  const { branchName } = req.body || {};
  if (!branchName) return res.status(400).json({ error: "branchName required" });
  try {
    const result = await git.mergeBranch(cwd, { branchName, identity: identityForUser(req.user) });
    const data = git.getSnapshot(cwd);
    data.piBusy = isSpaceBusy(req.params.spaceId);
    res.json({ ok: true, merged: result.merged, aborted: result.aborted, conflicts: result.conflicts, data });
  } catch (e) {
    sendGitError(res, e, 400);
  }
});

export default router;
