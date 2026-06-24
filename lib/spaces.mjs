import { randomUUID } from "crypto";
import { execSync, spawn } from "child_process";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { config } from "./config.mjs";
import db from "./db.mjs";

mkdirSync(config.reposDir, { recursive: true });

export function cloneRepo(repoUrl, branch = "main", userId) {
  const spaceId = randomUUID();
  const localPath = join(config.reposDir, spaceId);
  const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo";

  execSync(`git clone --branch ${branch} ${repoUrl} ${localPath}`, {
    stdio: "pipe",
    timeout: 60000,
  });

  let repoFullName = null;
  try {
    repoFullName = execSync("git config --get remote.origin.url", { cwd: localPath }).toString().trim();
  } catch {}

  db.prepare(`
    INSERT INTO spaces (id, owner_id, repo_url, repo_name, repo_full_name, branch, local_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(spaceId, userId, repoUrl, repoName, repoFullName, branch, localPath);

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
