import { Router } from "express";
import multer from "multer";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import { cloneRepo, getSpace, listSpaces, listSpacesByOrg, deleteSpace, pullSpace, getSpacePath } from "../lib/spaces.mjs";
import { isOrgMember } from "../lib/orgs.mjs";
import { GitOps } from "../lib/git-ops.mjs";
const router = Router();

const upload = multer({
  limits: { fileSize: 500 * 1024 * 1024, files: 20 },
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, getSpacePath(req.params.spaceId));
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    }
  })
});

router.post("/api/spaces/:spaceId/upload", requireAuth, requireSpaceAccess, upload.array("files", 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ err: "No files uploaded" });
  }
  const filenames = req.files.map(f => f.originalname);
  res.json({ success: true, files: filenames });
});

router.get("/api/spaces", requireAuth, (req, res) => {
  const orgId = req.query.orgId;
  if (orgId) {
    const member = isOrgMember(orgId, req.user.id);
    if (!member) return res.status(403).json({ err: "Not an org member" });
    return res.json(listSpacesByOrg(orgId));
  }
  return res.json(listSpaces(req.user.id));
});

router.post("/api/spaces", requireAuth, async (req, res) => {
  const { repoUrl, branch, authUser, authToken, orgId } = req.body;
  console.log("[spaces] clone req:", { repoUrl, branch, orgId, userId: req.user.id, hasAuth: !!authUser });
  if (!repoUrl) return res.status(400).json({ err: "repoUrl required" });
  const member = isOrgMember(orgId, req.user.id);
  if (!member || member.role === "viewer") return res.status(403).json({ err: "Editor required" });
  const space = cloneRepo(repoUrl, branch || "main", req.user.id, orgId, { authUser, authToken });
  return res.json(space);
});

router.get("/api/spaces/:spaceId", requireAuth, requireSpaceAccess, (req, res) => {
  const space = getSpace(req.params.spaceId);
  if (!space) return res.status(403).json({ err: "Not found" });
  return res.json(space);
});

// Git operations
router.get("/api/spaces/:spaceId/git", requireAuth, requireSpaceAccess, async (req, res) => {
  const space = getSpace(req.params.spaceId);
  const gitOps = new GitOps(space.local_path);
  
  try {
    const [status, commits, currentBranch, branches] = await Promise.all([
      gitOps.getStatus(),
      gitOps.getRecentCommits(10),
      gitOps.getCurrentBranch(),
      gitOps.getBranches()
    ]);
    
    return res.json({
      status,
      commits,
      currentBranch,
      branches,
      hasUncommittedChanges: gitOps.hasUncommittedChanges()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/api/spaces/:spaceId/git/switch-branch", requireAuth, requireSpaceAccess, async (req, res) => {
  const { branchName, stashChanges } = req.body;
  const space = getSpace(req.params.spaceId);
  const gitOps = new GitOps(space.local_path);
  
  try {
    await gitOps.switchBranch(branchName, stashChanges);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/api/spaces/:spaceId/git/create-branch", requireAuth, requireSpaceAccess, async (req, res) => {
  const { branchName, baseBranch } = req.body;
  const space = getSpace(req.params.spaceId);
  const gitOps = new GitOps(space.local_path);
  
  try {
    await gitOps.createBranch(branchName, baseBranch);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/api/spaces/:spaceId/git/pull", requireAuth, requireSpaceAccess, async (req, res) => {
  const space = getSpace(req.params.spaceId);
  const gitOps = new GitOps(space.local_path);
  
  try {
    await gitOps.pull();
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/api/spaces/:spaceId/pull", requireAuth, requireSpaceAccess, async (req, res) => {
  const output = await pullSpace(req.params.spaceId);
  return res.json({ output });
});

router.delete("/api/spaces/:spaceId", requireAuth, requireSpaceAccess, (req, res) => {
  if (req.spaceRole !== "owner") return res.status(403).json({ err: "Owner only" });
  deleteSpace(req.params.spaceId);
  return res.json({ ok: true });
});

// SSE endpoint for real-time git status updates
router.get("/api/spaces/:spaceId/git/sse", requireAuth, requireSpaceAccess, (req, res) => {
  const space = getSpace(req.params.spaceId);
  const gitOps = new GitOps(space.local_path);
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial status
  const sendStatus = async () => {
    try {
      const [status, commits, currentBranch, branches] = await Promise.all([
        gitOps.getStatus(),
        gitOps.getRecentCommits(10),
        gitOps.getCurrentBranch(),
        gitOps.getBranches()
      ]);
      
      res.write(`data: ${JSON.stringify({
        status,
        commits,
        currentBranch,
        branches,
        hasUncommittedChanges: gitOps.hasUncommittedChanges()
      })}\\n\\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\\n\\n`);
    }
  };
  
  sendStatus();
  
  // Set up interval to send updates every 5 seconds
  const interval = setInterval(sendStatus, 5000);
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

export default router;