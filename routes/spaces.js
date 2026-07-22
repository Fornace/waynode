import { Router } from "express";
import multer from "multer";
import { requireAuth, requireSpaceAccess, queryTokenAuth } from "../lib/auth.mjs";
import { cloneRepo, getSpace, listSpaces, listSpacesByOrg, deleteSpace, pullSpace, getSpacePath, createSpaceRecord, cloneRepoStreaming, assertSafeRepoUrl } from "../lib/spaces.mjs";
import { isOrgMember } from "../lib/orgs.mjs";
import { startClone, publish, finishClone, subscribe } from "../lib/clone-progress.mjs";
import { config } from "../lib/config.mjs";
import path from "path";
import { rmSync } from "fs";
import db from "../lib/db.mjs";
import { assertOrgStorageCapacity, refreshOrgStorageUsage } from "../lib/storage-quota.mjs";
import { requireHammersmithLeaseAvailable } from "../lib/hammersmith-lease.mjs";
const router = Router();

function requireSpaceEditor(req, res, next) {
  if (req.spaceRole === "viewer") return res.status(403).json({ err: "Editor required" });
  next();
}

function requireSpaceStorageCapacity(req, res, next) {
  const space = getSpace(req.params.spaceId);
  if (!space?.org_id) return next();
  // Content-Length includes multipart framing, so it is conservative for the
  // incoming file payload. A post-write check below catches chunked uploads.
  const incoming = Number.parseInt(String(req.headers["content-length"] || "0"), 10);
  try {
    assertOrgStorageCapacity(space.org_id, Number.isFinite(incoming) ? incoming : 0);
    next();
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}

const upload = multer({
  limits: { fileSize: 500 * 1024 * 1024, files: 20 },
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, getSpacePath(req.params.spaceId));
    },
    filename: (req, file, cb) => {
      // Strip any directory components from the user-supplied name so an
      // originalname like "../../app/server.js" can't escape the space dir.
      cb(null, path.basename(file.originalname) || `upload-${Date.now()}`);
    }
  })
});

router.post("/api/spaces/:spaceId/upload", requireAuth, requireSpaceAccess, requireSpaceEditor, requireHammersmithLeaseAvailable, requireSpaceStorageCapacity, upload.array("files", 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ err: "No files uploaded" });
  }
  const space = getSpace(req.params.spaceId);
  try {
    // Enforce after disk write too, then remove only this request's files if a
    // chunked/lying Content-Length crossed the hard plan boundary.
    assertOrgStorageCapacity(space?.org_id);
  } catch (error) {
    for (const file of req.files) {
      try { rmSync(file.path, { force: true }); } catch {}
    }
    refreshOrgStorageUsage(space?.org_id);
    return res.status(error.status || 500).json({ error: error.message });
  }
  const filenames = req.files.map(f => f.originalname);
  refreshOrgStorageUsage(space?.org_id);
  res.json({ success: true, files: filenames });
});

router.get("/api/spaces", requireAuth, (req, res) => {
  const orgId = req.query.orgId;
  if (orgId) {
    const member = isOrgMember(orgId, req.user.id);
    if (!member) return res.status(403).json({ err: "Not an org member" });
    return res.json(listSpacesByOrg(orgId, req.user.id));
  }
  return res.json(listSpaces(req.user.id));
});

router.post("/api/spaces", requireAuth, async (req, res) => {
  const { repoUrl, branch, authUser, authToken, orgId } = req.body;
  console.log("[spaces] clone req:", { repoUrl, branch, orgId, userId: req.user.id, hasAuth: !!authUser });
  if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });
  let safeUrl;
  try {
    safeUrl = assertSafeRepoUrl(repoUrl);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const member = isOrgMember(orgId, req.user.id);
  if (!member || member.role === "viewer") return res.status(403).json({ err: "Editor required" });
  if (orgId) {
    await refreshOrgStorageUsage(orgId).catch((err) => {
      console.error("[spaces] Failed to refresh storage usage before checking capacity:", err.message);
    });
  }
  try {
    assertOrgStorageCapacity(orgId);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  // Create the space row immediately so a session can reference it; clone
  // streams in the background and clients subscribe via /clone-events.
  const space = createSpaceRecord(safeUrl, branch || "main", req.user.id, orgId);
  startClone(space.id);
  (async () => {
    try {
      await cloneRepoStreaming(space, { authUser, authToken, onProgress: (l) => publish(space.id, l) });
      assertOrgStorageCapacity(orgId);
      refreshOrgStorageUsage(orgId);
      finishClone(space.id);
    } catch (e) {
      if (e.status === 402) {
        try { deleteSpace(space.id); } catch {}
      }
      finishClone(space.id, e.message);
      if (orgId) {
        refreshOrgStorageUsage(orgId).catch(() => {});
      }
    }
  })();
  return res.json({ ...space, cloning: true });
});

// dev-token may arrive as ?t= for EventSource (can't set headers)
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

// Live clone progress (SSE). Replays buffered lines, then streams until done.
router.get("/api/spaces/:spaceId/clone-events", sseAuth, requireSpaceAccess, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const unsub = subscribe(req.params.spaceId, (ev) => writeSSE(res, ev));
  const ping = setInterval(() => writeSSE(res, { type: "ping" }), 25000);
  // If the space has no active/known clone entry, tell the client it's already done.
  req.on("close", () => { clearInterval(ping); unsub(); });
});

router.get("/api/spaces/:spaceId", requireAuth, requireSpaceAccess, (req, res) => {
  const space = getSpace(req.params.spaceId);
  if (!space) return res.status(403).json({ err: "Not found" });
  return res.json(space);
});

// Git operations are handled in routes/git.js (snapshot, SSE, commit,
// switch/create branch, merge, push, pull) — all with --no-optional-locks and
// the per-space write mutex. This file keeps only space CRUD.

router.post("/api/spaces/:spaceId/pull", requireAuth, requireSpaceAccess, requireSpaceEditor, requireHammersmithLeaseAvailable, async (req, res) => {
  try {
    const output = await pullSpace(req.params.spaceId);
    return res.json({ output });
  } catch (e) {
    if (e.spaceDirMissing) return res.status(409).json({ error: e.message, spaceDirMissing: true });
    if (e.gitBusy) return res.status(409).json({ error: e.message, gitBusy: true });
    return res.status(400).json({ error: e.message });
  }
});

router.delete("/api/spaces/:spaceId", requireAuth, requireSpaceAccess, requireHammersmithLeaseAvailable, (req, res) => {
  if (req.spaceRole !== "owner") return res.status(403).json({ err: "Owner only" });
  const space = getSpace(req.params.spaceId);
  const orgId = space?.org_id;
  deleteSpace(req.params.spaceId);
  if (orgId) {
    refreshOrgStorageUsage(orgId);
  }
  return res.json({ ok: true });
});

// SSE git status is handled in routes/git.js (/api/spaces/:spaceId/git/sse)
// with --no-optional-locks and change-diffing (only pushes on actual change).

export default router;
