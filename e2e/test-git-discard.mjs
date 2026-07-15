#!/usr/bin/env node
/** End-to-end contract for authorized, tracked-only Git discard actions. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "waynode-git-discard-"));
const repo = join(root, "repo");
const dataDir = join(root, "data");
const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", resolve);
});
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const devToken = "git-discard-test-token";

function git(...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function file(name) {
  return join(repo, name);
}

async function request(path, { auth = true, ...options } = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { "x-dev-token": devToken } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}

function discardFile(path, confirmation = "DISCARD TRACKED FILE") {
  return request("/api/spaces/discard-space/git/discard-file", {
    method: "POST", body: JSON.stringify({ path, confirmation }),
  });
}

function discardAll(confirmation = "DISCARD ALL TRACKED CHANGES") {
  return request("/api/spaces/discard-space/git/discard-all", {
    method: "POST", body: JSON.stringify({ confirmation }),
  });
}

spawnSync("git", ["init", "-q", repo]);
writeFileSync(file("tracked.txt"), "baseline\n");
writeFileSync(file("deleted.txt"), "deleted baseline\n");
writeFileSync(file("rename-old.txt"), "rename baseline\n");
writeFileSync(file(":(glob)*.txt"), "literal baseline\n");
writeFileSync(file(".gitignore"), "*.ignored\n");
git("add", ".");
git("-c", "user.name=Waynode Test", "-c", "user.email=test@example.test", "commit", "-qm", "baseline");

const server = spawn("node", ["server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port), NODE_ENV: "test", DATA_DIR: dataDir,
    DEV_AUTH_TOKEN: devToken, SESSION_SECRET: "git-discard-session",
    ENCRYPTION_KEY: "0".repeat(64), APP_URL: base,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (chunk) => process.stderr.write(`[server!] ${chunk}`));

try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(1_000) })).ok) break;
    } catch {}
    if (attempt === 39) throw new Error("Server did not start");
    await sleep(250);
  }

  // Dev authentication creates this user lazily; seed a personal space where
  // that user begins as a viewer so the write authorization is exercised.
  await request("/api/auth/me");
  const db = new DatabaseSync(join(dataDir, "waynode.db"));
  db.prepare("INSERT INTO users (id, name) VALUES ('space-owner', 'Space Owner')").run();
  db.prepare(`
    INSERT INTO spaces (id, owner_id, repo_url, repo_name, local_path)
    VALUES ('discard-space', 'space-owner', 'https://example.test/repo.git', 'repo', ?)
  `).run(repo);
  db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES ('discard-space', 'dev-user', 'viewer')").run();

  writeFileSync(file("tracked.txt"), "changed\n");
  let result = await request("/api/spaces/discard-space/git/discard-file", {
    auth: false, method: "POST",
    body: JSON.stringify({ path: "tracked.txt", confirmation: "DISCARD TRACKED FILE" }),
  });
  assert.equal(result.status, 401, "discard requires authentication");
  result = await discardFile("tracked.txt");
  assert.equal(result.status, 403, "viewer cannot discard changes");
  db.prepare("UPDATE space_members SET role = 'editor' WHERE space_id = 'discard-space' AND user_id = 'dev-user'").run();

  result = await discardFile("tracked.txt", "discard it");
  assert.equal(result.status, 400, "file discard requires an exact confirmation");
  assert.equal(result.body.confirmationRequired, true);
  result = await discardFile("../outside.txt");
  assert.equal(result.status, 400, "paths outside the repository are rejected");
  assert.equal(result.body.invalidPath, true);

  writeFileSync(file("keep-untracked.txt"), "keep me\n");
  result = await discardFile("keep-untracked.txt");
  assert.equal(result.status, 409, "untracked files cannot be deleted through tracked discard");
  assert.equal(result.body.untrackedPreserved, true);
  assert.equal(readFileSync(file("keep-untracked.txt"), "utf8"), "keep me\n");

  writeFileSync(file(":(glob)*.txt"), "literal changed\n");
  result = await discardFile(":(glob)*.txt");
  assert.equal(result.status, 200, "Git pathspec-looking names are restored literally");
  assert.equal(readFileSync(file(":(glob)*.txt"), "utf8"), "literal baseline\n");
  assert.equal(readFileSync(file("tracked.txt"), "utf8"), "changed\n", "literal restore cannot touch another file");

  rmSync(file("deleted.txt"));
  result = await discardFile("deleted.txt");
  assert.equal(result.status, 200, "a deleted tracked file can be safely restored");
  assert.equal(readFileSync(file("deleted.txt"), "utf8"), "deleted baseline\n");

  git("mv", "rename-old.txt", "rename-new.txt");
  result = await discardFile("rename-new.txt");
  assert.equal(result.status, 409, "one-file discard rejects ambiguous rename state");
  assert.equal(result.body.unsupportedTrackedState, true);
  assert.equal(existsSync(file("rename-new.txt")), true, "rejected rename is untouched");
  result = await discardAll();
  assert.equal(result.status, 200, "discard-all restores only safe tracked paths");
  assert.equal(existsSync(file("rename-new.txt")), true, "discard-all preserves ambiguous rename state");
  assert.equal(readFileSync(file("tracked.txt"), "utf8"), "baseline\n", "safe tracked edits are still restored");
  assert.equal(result.body.result.preservedUnsupported, 1, "preserved tracked state is reported truthfully");
  git("reset", "--hard", "HEAD");
  writeFileSync(file("tracked.txt"), "changed\n");

  writeFileSync(file("added.txt"), "staged addition\n");
  git("add", "added.txt");
  result = await discardFile("added.txt");
  assert.equal(result.status, 409, "one-file discard rejects a staged addition");
  assert.equal(result.body.unsupportedTrackedState, true);
  assert.equal(readFileSync(file("added.txt"), "utf8"), "staged addition\n", "rejected addition keeps its bytes");
  git("reset", "HEAD", "--", "added.txt");
  rmSync(file("added.txt"));

  writeFileSync(file("tracked.txt"), "changed again\n");
  writeFileSync(file("all-added.txt"), "tracked addition\n");
  writeFileSync(file("cache.ignored"), "keep ignored\n");
  git("add", "tracked.txt", "all-added.txt");
  result = await discardAll("nope");
  assert.equal(result.status, 400, "discard-all requires its stronger exact confirmation");
  result = await discardAll();
  assert.equal(result.status, 200, "confirmed discard-all restores tracked index and worktree state");
  assert.equal(readFileSync(file("tracked.txt"), "utf8"), "baseline\n");
  assert.equal(readFileSync(file("all-added.txt"), "utf8"), "tracked addition\n", "staged additions keep their bytes");
  assert.equal(git("status", "--short", "all-added.txt"), "A  all-added.txt", "staged addition state is preserved too");
  assert.equal(result.body.result.preservedUnsupported, 1, "preserved staged additions are reported");
  assert.equal(readFileSync(file("keep-untracked.txt"), "utf8"), "keep me\n", "untracked content is preserved");
  assert.equal(readFileSync(file("cache.ignored"), "utf8"), "keep ignored\n", "ignored content is preserved");
  assert.equal(result.body.data.files.some((entry) => entry.path === "keep-untracked.txt"), true, "response includes the refreshed snapshot");

  result = await discardAll();
  assert.equal(result.status, 200, "discard-all is idempotent when only untracked content remains");
  assert.equal(result.body.result.discarded, 0);
  assert.equal(
    git("status", "--short"),
    "A  all-added.txt\n?? keep-untracked.txt",
    "preserved staged additions and pre-existing untracked content remain visible",
  );
  console.log("git discard authorization and safety regression passed");
} finally {
  server.kill("SIGTERM");
  await sleep(200);
  rmSync(root, { recursive: true, force: true });
}
