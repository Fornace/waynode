import { Router } from "express";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, sep } from "path";
import db from "../lib/db.mjs";

const router = Router();

function getSpacePath(spaceId) {
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(spaceId);
  return space?.local_path;
}

// Reject paths that escape the space dir (path traversal via ../, absolute
// paths, etc.). resolve() collapses ".." lexically; we then require the result
// to be the space dir itself or live beneath it. The trailing-separator check
// avoids prefix confusion (e.g. /data/repos/abc vs /data/repos/abcd).
function assertInsideSpace(spacePath, relPath) {
  const abs = resolve(spacePath, relPath || ".");
  if (abs !== spacePath && !abs.startsWith(spacePath + sep)) {
    const err = new Error("Invalid path");
    err.status = 400;
    throw err;
  }
  return abs;
}

router.get("/api/spaces/:spaceId/files", requireAuth, requireSpaceAccess, (req, res) => {
  const spacePath = getSpacePath(req.params.spaceId);
  if (!spacePath) return res.status(404).json({ error: "Space not found" });

  const relPath = req.query.path || "";
  try {
    const absPath = assertInsideSpace(spacePath, relPath);
    if (!existsSync(absPath)) return res.status(404).json({ error: "Not found" });
    if (statSync(absPath).isDirectory()) {
      const entries = readdirSync(absPath)
        .filter((name) => !name.startsWith(".git") || relPath)
        .map((name) => {
          const stat = statSync(join(absPath, name));
          return { name, isDirectory: stat.isDirectory(), size: stat.size };
        });
      res.json({ type: "directory", path: relPath, entries });
    } else {
      const content = readFileSync(absPath, "utf8");
      res.json({ type: "file", path: relPath, content });
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put("/api/spaces/:spaceId/files", requireAuth, requireSpaceAccess, (req, res) => {
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only" });

  const spacePath = getSpacePath(req.params.spaceId);
  if (!spacePath) return res.status(404).json({ error: "Space not found" });

  const { path: relPath, content } = req.body;
  if (!relPath) return res.status(400).json({ error: "path required" });

  try {
    const absPath = assertInsideSpace(spacePath, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content || "");
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
