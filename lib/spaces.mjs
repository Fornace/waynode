import { randomUUID } from "crypto";
import { spawnSync, spawn } from "child_process";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { config } from "./config.mjs";
import db from "./db.mjs";
import { syncSpaceMemberships } from "./space-access.mjs";
import {
  askpassEnv, beginTrustedGitOperation, credsForOwner, explicitCredentials, trustedGitEnvForCwd,
} from "./git-creds.mjs";

mkdirSync(config.reposDir, { recursive: true });

export function getSpacePath(spaceId) {
  return join(config.reposDir, spaceId);
}

const SCP_LIKE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:/;

/**
 * Validate a user-supplied repository URL before handing it to git.
 *
 * git interprets some URL-like strings as pseudo-transports that execute
 * commands (notably `ext::sh -c '...'`) and also accepts `file://` plus
 * leading-dash option injection. This allowlist keeps only the network
 * transports we actually use: http(s), git, ssh, and SCP-style git@host:path.
 */
function configuredHostedOrigins() {
  const origins = new Set(["https://github.com"]);
  try {
    const gitlab = new URL(config.gitlab.baseUrl);
    if (gitlab.protocol === "https:") origins.add(gitlab.origin);
  } catch {}
  return origins;
}

export function assertSafeRepoUrl(repoUrl, {
  deployment = config.deployment,
  hostedOrigins = configuredHostedOrigins(),
} = {}) {
  if (typeof repoUrl !== "string" || !repoUrl.trim()) {
    throw new Error("Repository URL required");
  }
  const url = repoUrl.trim();
  if (url.startsWith("-")) throw new Error("Invalid repository URL");
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.startsWith("ext::") || lowerUrl.startsWith("file:")) {
    throw new Error("Unsupported repository URL scheme");
  }
  if (deployment !== "hosted" && SCP_LIKE.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (deployment === "hosted") {
      if (parsed.protocol !== "https:") {
        throw new Error("Hosted repositories must use HTTPS");
      }
      if (!hostedOrigins.has(parsed.origin)) {
        throw new Error("Hosted repositories must use an approved Git provider");
      }
    }
    if (!["http:", "https:", "git:", "ssh:"].includes(parsed.protocol)) {
      throw new Error("Unsupported repository URL scheme");
    }
    if (parsed.password || ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username)) {
      throw new Error("Repository credentials must not be embedded in the URL");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("Repository URL must not contain a query or fragment");
    }
    return url;
  } catch (error) {
    if (["Repository ", "Unsupported ", "Hosted "].some((prefix) => error.message.startsWith(prefix))) {
      throw error;
    }
  }
  throw new Error("Unsupported repository URL scheme");
}

function cloneCredentials(repoUrl, ownerId, auth = {}) {
  if (auth.authUser || auth.authToken) {
    const credentials = explicitCredentials(repoUrl, auth.authUser, auth.authToken);
    if (!credentials) throw new Error("Valid HTTPS clone credentials are required");
    return credentials;
  }
  return credsForOwner(repoUrl, ownerId);
}

function trustedGitEnv(credentials) {
  const hosted = config.deployment === "hosted";
  return {
    ...process.env,
    ...askpassEnv(credentials, { harden: hosted || !!credentials, denySsh: hosted || !!credentials }),
  };
}

export function cloneRepo(repoUrl, branch = "main", userId, orgId, auth = {}) {
  repoUrl = assertSafeRepoUrl(repoUrl);
  const spaceId = randomUUID();
  const localPath = join(config.reposDir, spaceId);
  const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo";

  const credentials = cloneCredentials(repoUrl, userId, auth);

  const result = spawnSync("git", ["clone", "--branch", branch, repoUrl, localPath], {
    stdio: "pipe",
    timeout: 60000,
    encoding: "utf8",
    env: trustedGitEnv(credentials),
  });

  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.stdout?.trim() || `git clone exited ${result.status}`;
    throw new Error(err);
  }

  const repoFullName = repoUrl;

  db.prepare(`
    INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, repo_full_name, branch, local_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(spaceId, orgId || null, userId, repoUrl, repoName, repoFullName, branch, localPath);

  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')
  `).run(spaceId, userId);
  syncSpaceMemberships(spaceId);

  return getSpace(spaceId);
}

/**
 * Create the space DB row + owner membership WITHOUT cloning, so a session can
 * reference the space immediately while the clone streams in the background.
 */
export function createSpaceRecord(repoUrl, branch = "main", userId, orgId) {
  const spaceId = randomUUID();
  const localPath = join(config.reposDir, spaceId);
  const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo";
  db.prepare(`
    INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, repo_full_name, branch, local_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(spaceId, orgId || null, userId, repoUrl, repoName, repoUrl, branch, localPath);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')
  `).run(spaceId, userId);
  syncSpaceMemberships(spaceId);
  return getSpace(spaceId);
}

/**
 * Streaming clone: runs `git clone --progress` and calls onProgress(line) for
 * each progress line (from stderr, where git writes --progress output). Resolves
 * on success, rejects on non-zero exit. The directory must not yet exist.
 */
export function cloneRepoStreaming(space, { authUser, authToken, onProgress } = {}) {
  const repoUrl = assertSafeRepoUrl(space.repo_url);
  const credentials = cloneCredentials(repoUrl, space.owner_id, { authUser, authToken });
  return new Promise((resolve, reject) => {
    let release;
    let git;
    try {
      release = beginTrustedGitOperation(space.local_path);
      git = spawn("git", ["clone", "--progress", "--branch", space.branch || "main", repoUrl, space.local_path], {
        stdio: ["ignore", "pipe", "pipe"], env: trustedGitEnv(credentials),
      });
    } catch (error) {
      release?.();
      reject(error);
      return;
    }
    let stderrBuf = "";
    git.stderr.on("data", (d) => {
      stderrBuf += d.toString();
      // --progress uses \r to update in place; emit only completed (\n or \r-terminated) fragments
      let idx;
      while ((idx = Math.max(stderrBuf.indexOf("\n"), stderrBuf.indexOf("\r"))) !== -1) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line) onProgress?.(line);
      }
    });
    git.on("error", (error) => { release(); reject(error); });
    git.on("close", (code) => {
      release();
      if (stderrBuf.trim()) onProgress?.(stderrBuf.trim());
      if (code === 0) resolve();
      else reject(new Error(stderrBuf.trim() || `git clone exited ${code}`));
    });
  });
}

export function getSpace(spaceId) {
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM sessions WHERE space_id = s.id) as session_count
    FROM spaces s WHERE s.id = ?
  `).get(spaceId);
}

/** Lookup by the 8-hex short id (suffix of a UUID, dashes removed). */
export function getSpaceByShortId(shortId) {
  return db
    .prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM sessions WHERE space_id = s.id) as session_count
      FROM spaces s WHERE lower(substr(replace(s.id, '-', ''), 1, 8)) = ?
    `)
    .get(String(shortId || "").toLowerCase());
}

export function listSpaces(userId) {
  return db.prepare(`
    SELECT s.*,
      CASE
        WHEN s.org_id IS NOT NULL AND (s.owner_id = ? OR om.role = 'admin') THEN 'owner'
        WHEN s.org_id IS NOT NULL THEN om.role
        WHEN s.owner_id = ? THEN 'owner'
        ELSE sm.role
      END as my_role,
      (SELECT COUNT(*) FROM sessions WHERE space_id = s.id) as session_count,
      (SELECT title FROM sessions WHERE space_id = s.id ORDER BY updated_at DESC LIMIT 1) as latest_session_title,
      (SELECT updated_at FROM sessions WHERE space_id = s.id ORDER BY updated_at DESC LIMIT 1) as latest_session_at
    FROM spaces s
    LEFT JOIN org_members om ON om.org_id = s.org_id AND om.user_id = ?
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
    WHERE (s.org_id IS NOT NULL AND om.user_id IS NOT NULL)
       OR (s.org_id IS NULL AND (s.owner_id = ? OR sm.user_id IS NOT NULL))
    ORDER BY s.created_at DESC
  `).all(userId, userId, userId, userId, userId);
}

export function listSpacesByOrg(orgId, userId) {
  return db.prepare(`
    SELECT s.*,
      CASE WHEN s.owner_id = ? OR om.role = 'admin' THEN 'owner' ELSE om.role END as my_role,
      (SELECT COUNT(*) FROM sessions WHERE space_id = s.id) as session_count,
      (SELECT title FROM sessions WHERE space_id = s.id ORDER BY updated_at DESC LIMIT 1) as latest_session_title,
      (SELECT updated_at FROM sessions WHERE space_id = s.id ORDER BY updated_at DESC LIMIT 1) as latest_session_at
    FROM spaces s
    JOIN org_members om ON om.org_id = s.org_id AND om.user_id = ?
    WHERE s.org_id = ?
    ORDER BY s.created_at DESC
  `).all(userId, userId, orgId);
}

/** Internal administrative enumeration; never use for a user-facing response. */
export function listAllSpacesByOrg(orgId) {
  return db.prepare("SELECT * FROM spaces WHERE org_id = ? ORDER BY created_at DESC").all(orgId);
}

export function deleteSpace(spaceId) {
  const space = getSpace(spaceId);
  if (!space) return false;

  if (existsSync(space.local_path)) {
    rmSync(space.local_path, { recursive: true, force: true });
  }

  db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
  return true;
}

export function pullSpace(spaceId) {
  const space = getSpace(spaceId);
  if (!space) throw new Error("Space not found");
  if (!existsSync(space.local_path)) {
    const err = new Error("Space directory not found on disk — it may have been deleted outside the app");
    err.spaceDirMissing = true;
    throw err;
  }

  return new Promise((resolve, reject) => {
    let release;
    let git;
    try {
      release = beginTrustedGitOperation(space.local_path);
      git = spawn("git", ["pull"], {
        cwd: space.local_path,
        env: trustedGitEnvForCwd(space.local_path, { auth: true }),
      });
    } catch (error) {
      release?.();
      reject(error);
      return;
    }
    let output = "";
    git.stdout.on("data", (d) => (output += d.toString()));
    git.stderr.on("data", (d) => (output += d.toString()));
    git.on("error", (error) => { release(); reject(error); });
    git.on("close", (code) => {
      release();
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || "git pull failed"));
    });
  });
}
