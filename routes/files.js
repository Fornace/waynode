import { Router } from "express";
import { requireAuth, requireSpaceAccess } from "../lib/auth.mjs";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync, lstatSync } from "fs";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
import db from "../lib/db.mjs";
import { assertOrgStorageCapacity, refreshOrgStorageUsage } from "../lib/storage-quota.mjs";

const router = Router();
const MAX_EDITABLE_FILE_BYTES = 1_000_000;

function getSpacePath(spaceId) {
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(spaceId);
  return space?.local_path;
}

// Reject paths that escape the space dir (path traversal via ../, absolute
// paths, etc.). resolve() collapses ".." lexically; we then require the result
// to be the space dir itself or live beneath it. The trailing-separator check
// avoids prefix confusion (e.g. /data/repos/abc vs /data/repos/abcd).
function assertInsideSpace(spacePath, relPath) {
  if (typeof relPath !== "string" || relPath.includes("\0")) {
    const err = new Error("Invalid path");
    err.status = 400;
    throw err;
  }
  const root = realpathSync(spacePath);
  const lexical = resolve(root, relPath || ".");
  if (lexical !== root && !lexical.startsWith(root + sep)) {
    const err = new Error("Invalid path");
    err.status = 400;
    throw err;
  }
  const resolved = realpathSync(lexical);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    const err = new Error("Invalid path");
    err.status = 400;
    throw err;
  }
  return resolved;
}

router.get("/api/spaces/:spaceId/files", requireAuth, requireSpaceAccess, (req, res) => {
  const spacePath = getSpacePath(req.params.spaceId);
  if (!spacePath) return res.status(404).json({ error: "Space not found" });

  const relPath = req.query.path || "";
  try {
    const absPath = assertInsideSpace(spacePath, relPath);
    if (!existsSync(absPath)) return res.status(404).json({ error: "Not found" });
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      const entries = readdirSync(absPath)
        .filter((name) => !name.startsWith(".git") || relPath)
        .map((name) => {
          const stat = statSync(join(absPath, name));
          return { name, isDirectory: stat.isDirectory(), size: stat.size };
        });
      res.json({ type: "directory", path: relPath, entries });
    } else {
      if (!stat.isFile() || lstatSync(absPath).isSymbolicLink()) return res.status(400).json({ error: "Only regular files can be opened" });
      if (stat.size > MAX_EDITABLE_FILE_BYTES) return res.status(413).json({ error: "Files larger than 1 MB can't be edited here" });
      const content = readFileSync(absPath, "utf8");
      if (content.includes("\0")) return res.status(415).json({ error: "Binary files can't be edited here" });
      res.json({ type: "file", path: relPath, content, revision: createHash("sha256").update(content).digest("hex") });
    }
  } catch (err) {
    res.status(err.status || (err.code === "ENOENT" ? 404 : 500)).json({ error: err.code === "ENOENT" ? "Not found" : err.message });
  }
});

router.put("/api/spaces/:spaceId/files", requireAuth, requireSpaceAccess, (req, res) => {
  if (req.spaceRole === "viewer") return res.status(403).json({ error: "Read-only" });

  const spacePath = getSpacePath(req.params.spaceId);
  if (!spacePath) return res.status(404).json({ error: "Space not found" });

  const { path: relPath, content, revision } = req.body;
  if (!relPath) return res.status(400).json({ error: "path required" });
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_EDITABLE_FILE_BYTES) {
    return res.status(400).json({ error: "Provide non-binary text up to 1 MB" });
  }

  try {
    const space = db.prepare("SELECT org_id FROM spaces WHERE id = ?").get(req.params.spaceId);
    // This conservative reservation protects the file editor without trying
    // to infer a delta across filesystem block sizes. The post-save refresh
    // keeps billing usage current for subsequent writes.
    assertOrgStorageCapacity(space?.org_id, Buffer.byteLength(content, "utf8"));
    const absPath = assertInsideSpace(spacePath, relPath);
    const stat = statSync(absPath);
    if (!stat.isFile() || lstatSync(absPath).isSymbolicLink()) return res.status(400).json({ error: "Only regular files can be edited" });
    const current = readFileSync(absPath, "utf8");
    if (current.includes("\0")) return res.status(415).json({ error: "Binary files can't be edited here" });
    if (!revision || createHash("sha256").update(current).digest("hex") !== revision) {
      return res.status(409).json({ error: "This file changed since you opened it. Reload before saving." });
    }
    writeFileSync(absPath, content || "");
    refreshOrgStorageUsage(space?.org_id);
    res.json({ ok: true, revision: createHash("sha256").update(content).digest("hex") });
  } catch (err) {
    res.status(err.status || (err.code === "ENOENT" ? 404 : 500)).json({ error: err.code === "ENOENT" ? "Not found" : err.message });
  }
});

export default router;
