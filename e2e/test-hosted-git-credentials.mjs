/** Adversarial regression for the hosted Git credential boundary. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-hosted-git-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "test-session-secret";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";

const { default: db } = await import("../lib/db.mjs");
const { encryptOAuthToken } = await import("../lib/oauth-tokens.mjs");
const {
  askpassEnv,
  beginHostedGuestMutation,
  beginTrustedGitOperation,
  credsEnvForCwd,
  credsForSpace,
  enforceHostedGitCredentialBoundary,
  ensureGitAskpass,
} = await import("../lib/git-creds.mjs");
const { buildHostedSandboxEnv } = await import("../lib/pi-env.mjs");
const { assertSafeRepoUrl, cloneRepoStreaming, pullSpace } = await import("../lib/spaces.mjs");

const ownerToken = "gho_owner-token-should-never-persist";
const injectionToken = "gho_$(touch hosted-git-injection-sentinel)";
const worktree = join(root, "repos", "space");

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function credentialFill(url, credentials) {
  return spawnSync("git", ["credential", "fill"], {
    encoding: "utf8",
    input: `url=${url}\n\n`,
    env: { ...process.env, ...askpassEnv(credentials) },
  });
}

try {
  mkdirSync(worktree, { recursive: true });
  git(["init", "-q", worktree]);
  db.prepare("INSERT INTO users (id, name, email, github_token) VALUES (?, ?, ?, ?)")
    .run("owner", "Owner", "owner@example.test", encryptOAuthToken(ownerToken, "github"));
  db.prepare(`
    INSERT INTO spaces (id, owner_id, repo_url, repo_name, repo_full_name, local_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "space", "owner",
    `https://x-access-token:${ownerToken}@github.com/example/repo.git`,
    "repo", `https://x-access-token:${ownerToken}@github.com/example/repo.git`, worktree,
  );

  git(["-C", worktree, "remote", "add", "origin", `https://x-access-token:${ownerToken}@github.com/example/repo.git`]);
  git(["-C", worktree, "remote", "set-url", "--push", "origin", `https://x-access-token:${ownerToken}@github.com/other/repo.git`]);
  git(["-C", worktree, "remote", "add", "secondary", `https://oauth2:${ownerToken}@gitlab.com/example/repo.git`]);
  git(["-C", worktree, "config", "--local", "credential.helper", "!touch should-never-run"]);
  git(["-C", worktree, "config", "--local", "http.https://github.com/.extraheader", `Authorization: Bearer ${ownerToken}`]);
  git(["-C", worktree, "config", "--local", "core.hooksPath", "guest-hooks"]);
  git(["-C", worktree, "config", "--local", "include.path", "/tmp/guest-controlled-config"]);
  git(["-C", worktree, "config", "--local", "url.https://attacker.example/.insteadOf", "https://github.com/"]);
  git(["-C", worktree, "config", "--local", "waynode.arbitraryLeak", ownerToken]);

  enforceHostedGitCredentialBoundary("space");
  const configText = readFileSync(join(worktree, ".git", "config"), "utf8");
  assert.equal(configText.includes(ownerToken), false, "provider token is absent from .git/config");
  assert.equal(configText.includes("extraheader"), false, "persisted auth headers are removed");
  assert.equal(configText.includes("credential"), false, "guest credential helpers are removed");
  assert.equal(configText.includes("hooksPath"), false, "guest hooks cannot execute in trusted git children");
  assert.equal(configText.includes("include"), false, "guest config includes are removed");
  assert.equal(configText.includes("insteadOf"), false, "guest URL rewrites are removed");
  assert.equal(
    git(["-C", worktree, "remote", "get-url", "origin"]),
    "https://github.com/example/repo.git",
    "origin is restored to the authorized credential-free URL",
  );
  const stored = db.prepare("SELECT repo_url, repo_full_name FROM spaces WHERE id = ?").get("space");
  assert.equal(stored.repo_url, "https://github.com/example/repo.git");
  assert.equal(stored.repo_full_name, "https://github.com/example/repo.git");

  const tracked = join(worktree, "tracked.txt");
  writeFileSync(tracked, "before\n");
  git(["-C", worktree, "add", "tracked.txt"]);
  git(["-C", worktree, "-c", "user.name=Owner", "-c", "user.email=owner@example.test", "commit", "-qm", "baseline"]);
  writeFileSync(tracked, "after\n");

  const statusSentinel = join(root, "status-command-ran");
  const diffSentinel = join(root, "diff-command-ran");
  const commitSentinel = join(root, "commit-command-ran");
  git(["-C", worktree, "config", "--local", "core.fsmonitor", `touch ${statusSentinel}`]);
  const gitOps = await import("../lib/git-ops.mjs");
  const releaseGuest = beginHostedGuestMutation("space");
  assert.throws(
    () => gitOps.getStatus(worktree),
    /temporarily unavailable/,
    "host Git refuses to race a guest that can rewrite config after the scrub",
  );
  releaseGuest();
  assert.equal(gitOps.getStatus(worktree).hasUncommittedChanges, true);
  assert.equal(existsSync(statusSentinel), false, "status cannot execute guest fsmonitor config");
  const releaseTrusted = beginTrustedGitOperation(worktree);
  assert.throws(
    () => beginHostedGuestMutation("space"),
    /waiting for an active Git operation/,
    "a guest cannot start while an asynchronous trusted Git child is active",
  );
  releaseTrusted();

  git(["-C", worktree, "config", "--local", "diff.external", `touch ${diffSentinel}`]);
  assert.ok(gitOps.getFileDiff(worktree, "tracked.txt").includes("after"));
  assert.equal(existsSync(diffSentinel), false, "diff cannot execute guest external diff config");

  const hooksDir = join(worktree, "guest-hooks");
  mkdirSync(hooksDir);
  writeFileSync(join(hooksDir, "pre-commit"), `#!/bin/sh\ntouch '${commitSentinel}'\n`, { mode: 0o755 });
  writeFileSync(join(worktree, ".gitattributes"), "commit.txt filter=evil\n");
  writeFileSync(join(worktree, "commit.txt"), "safe content\n");
  git(["-C", worktree, "config", "--local", "core.hooksPath", hooksDir]);
  git(["-C", worktree, "config", "--local", "filter.evil.clean", `touch ${commitSentinel}; cat`]);
  git(["-C", worktree, "config", "--local", "commit.gpgsign", "true"]);
  git(["-C", worktree, "config", "--local", "gpg.program", `touch ${commitSentinel}`]);
  await gitOps.commitSelected(worktree, {
    files: [".gitattributes", "commit.txt"],
    summary: "safe hosted commit",
    identity: { name: "Owner", email: "owner@example.test" },
  });
  assert.equal(existsSync(commitSentinel), false, "commit cannot execute guest hooks, filters, or signing programs");

  ensureGitAskpass();
  assert.deepEqual(askpassEnv(null), {}, "self-hosted SSH behavior is unchanged without token credentials");
  const hostedNoCreds = askpassEnv(null, { harden: true, denySsh: true });
  assert.equal(hostedNoCreds.GIT_SSH, "/usr/bin/false", "hosted git never inherits server SSH keys");
  const credentials = credsForSpace("space");
  const allowed = credentialFill("https://github.com/example/repo.git", credentials);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /username=x-access-token/);
  assert.ok(allowed.stdout.includes(`password=${ownerToken}`));

  for (const unauthorized of [
    "https://github.com/example/different.git",
    "https://github.com@attacker.example/example/repo.git",
    "http://github.com/example/repo.git",
  ]) {
    const denied = credentialFill(unauthorized, credentials);
    assert.equal(`${denied.stdout}${denied.stderr}`.includes(ownerToken), false);
    assert.equal(denied.stdout.includes("password=\n"), true, `${unauthorized} receives no password`);
  }

  const guestEnv = buildHostedSandboxEnv({ ownerId: "owner" });
  assert.equal(guestEnv.WAYNODE_GIT_TOKEN, undefined);
  assert.equal(guestEnv.GIT_ASKPASS, undefined);
  assert.equal(Object.values(guestEnv).includes(ownerToken), false);

  assert.throws(
    () => assertSafeRepoUrl(`https://x-access-token:${ownerToken}@github.com/example/repo.git`),
    /must not be embedded/,
  );
  assert.throws(
    () => assertSafeRepoUrl("https://github.com/example/repo.git?access_token=secret"),
    /query or fragment/,
  );

  const binDir = join(root, "fake-bin");
  const captureArgs = join(root, "clone-args");
  const captureToken = join(root, "clone-token");
  const sentinel = join(root, "hosted-git-injection-sentinel");
  mkdirSync(binDir);
  const fakeGit = join(binDir, "git");
  writeFileSync(fakeGit, `#!/bin/sh
operation=""
for arg in "$@"; do
  case "$arg" in clone|pull|push) operation="$arg"; break ;; esac
done
if [ -n "$operation" ]; then
  printf '%s\\0' "$@" > "$CAPTURE_ARGS"
  printf '%s' "$WAYNODE_GIT_TOKEN" > "$CAPTURE_TOKEN"
  exit 0
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  chmodSync(fakeGit, 0o755);
  const originalPath = process.env.PATH;
  process.env.REAL_GIT = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.CAPTURE_ARGS = captureArgs;
  process.env.CAPTURE_TOKEN = captureToken;
  try {
    await cloneRepoStreaming({
      repo_url: "https://github.com/example/repo.git",
      owner_id: "owner",
      branch: `main; touch ${sentinel}`,
      local_path: join(root, "cloned"),
    }, { authUser: "x-access-token", authToken: injectionToken });
  } finally {
    process.env.PATH = originalPath;
  }
  const cloneArgs = readFileSync(captureArgs, "utf8").split("\0").filter(Boolean);
  assert.equal(cloneArgs.includes("https://github.com/example/repo.git"), true);
  assert.equal(cloneArgs.some((arg) => arg.includes(injectionToken)), false, "token is absent from argv");
  assert.equal(readFileSync(captureToken, "utf8"), injectionToken, "token reaches only the git child env");
  assert.equal(existsSync(sentinel), false, "credential and branch text never enters a shell");

  const pullArgsPath = join(root, "pull-args");
  const pullTokenPath = join(root, "pull-token");
  const pullSentinel = join(root, "pull-command-ran");
  git(["-C", worktree, "config", "--local", "core.sshCommand", `touch ${pullSentinel}`]);
  git(["-C", worktree, "config", "--local", "credential.helper", `!touch ${pullSentinel}`]);
  git(["-C", worktree, "config", "--local", "url.ssh://attacker.example/.insteadOf", "https://github.com/"]);
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.CAPTURE_ARGS = pullArgsPath;
  process.env.CAPTURE_TOKEN = pullTokenPath;
  try {
    await pullSpace("space");
  } finally {
    process.env.PATH = originalPath;
  }
  assert.deepEqual(readFileSync(pullArgsPath, "utf8").split("\0").filter(Boolean), ["pull"]);
  assert.equal(readFileSync(pullTokenPath, "utf8"), ownerToken, "trusted pull receives owner credentials ephemerally");
  assert.equal(existsSync(pullSentinel), false, "pull cannot execute guest SSH, helper, or URL rewrite config");

  const pushEnv = credsEnvForCwd(worktree);
  assert.equal(pushEnv.WAYNODE_GIT_TOKEN, ownerToken, "trusted push resolves the authorized owner token");
  assert.equal(pushEnv.WAYNODE_GIT_TARGET, "https://github.com/example/repo.git");
  assert.equal(pushEnv.GIT_CONFIG_VALUE_2, "/dev/null", "trusted push cannot execute guest hooks");
  const pushArgsPath = join(root, "push-args");
  const pushTokenPath = join(root, "push-token");
  const pushSentinel = join(root, "push-command-ran");
  writeFileSync(join(hooksDir, "pre-push"), `#!/bin/sh\ntouch '${pushSentinel}'\n`, { mode: 0o755 });
  git(["-C", worktree, "config", "--local", "core.hooksPath", hooksDir]);
  git(["-C", worktree, "remote", "set-url", "--push", "origin", "https://github.com/attacker/repo.git"]);
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.CAPTURE_ARGS = pushArgsPath;
  process.env.CAPTURE_TOKEN = pushTokenPath;
  try {
    await gitOps.push(worktree, { setUpstream: true });
  } finally {
    process.env.PATH = originalPath;
  }
  const pushArgs = readFileSync(pushArgsPath, "utf8").split("\0").filter(Boolean);
  assert.equal(pushArgs.includes("push"), true);
  assert.equal(pushArgs.includes("origin"), true);
  assert.equal(readFileSync(pushTokenPath, "utf8"), ownerToken, "trusted push receives owner credentials ephemerally");
  assert.equal(existsSync(pushSentinel), false, "push cannot execute guest hooks or redirect its credentialed remote");

  console.log("hosted git credential boundary regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
