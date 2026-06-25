import { randomUUID } from "crypto";
import { spawnSync, spawn } from "child_process";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { config } from "./config.mjs";
import db from "./db.mjs";

mkdirSync(config.reposDir, { recursive: true });

export function cloneRepo(repoUrl, branch = "main", userId, orgId, auth = {}) {
  const spaceId = randomUUID();
  const localPath = join(config.reposDir, spaceId);
  const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo";

  // Try user's stored GitHub token for private repos
  let cloneUrl = repoUrl;
  if (auth.authUser && auth.authToken) {
    cloneUrl = repoUrl.replace(/^https:\/\//, `https://${auth.authUser}:${auth.authToken}@`);
  } else if (repoUrl.includes("github.com")) {
    const user = db.prepare("SELECT github_token FROM users WHERE id = ?").get(userId);
    if (user?.github_token) {
      cloneUrl = repoUrl.replace(/^https:\/\//, `https://x-access-token:${user.github_token}@`);
    }
  } else if (repoUrl.includes("gitlab.com")) {
    const user = db.prepare("SELECT gitlab_token FROM users WHERE id = ?").get(userId);
    if (user?.gitlab_token) {
      cloneUrl = repoUrl.replace(/^https:\/\//, `https://oauth2:${user.gitlab_token}@`);
    }
  }

  const result = spawnSync("git", ["clone", "--branch", branch, cloneUrl, localPath], {
    stdio: "pipe",
    timeout: 60000,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.stdout?.trim() || `git clone exited ${result.status}`;
    throw new Error(err);
  }

  let repoFullName = repoUrl;
  try {
    const r = spawnSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: localPath, encoding: "utf8", stdio: "pipe",
    });
    if (!r.stdout?.trim().includes("@")) repoFullName = r.stdout?.trim() || repoUrl;
  } catch {}

  db.prepare(`
    INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, repo_full_name, branch, local_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(spaceId, orgId || null, userId, repoUrl, repoName, repoFullName, branch, localPath);

  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')
  `).run(spaceId, userId);

  return getSpace(spaceId);
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
      sm.role as my_role,
      (SELECT COUNT(*) FROM sessions WHERE space_id = s.id) as session_count
    FROM spaces s
    JOIN space_members sm ON sm.space_id = s.id
    WHERE sm.user_id = ?
    ORDER BY s.created_at DESC
  `).all(userId);
}

export function listSpacesByOrg(orgId) {
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM sessions WHERE space_id = s.id) as session_count
    FROM spaces s
    WHERE s.org_id = ?
    ORDER BY s.created_at DESC
  `).all(orgId);
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

  return new Promise((resolve, reject) => {
    const git = spawn("git", ["pull"], { cwd: space.local_path });
    let output = "";
    git.stdout.on("data", (d) => (output += d.toString()));
    git.stderr.on("data", (d) => (output += d.toString()));
    git.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || "git pull failed"));
    });
  });
}
