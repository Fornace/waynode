/**
 * lib/git-creds.mjs — resolve the CORRECT git credential for a space based on
 * its provider (GitHub vs GitLab), and expose it to git via a GIT_ASKPASS
 * helper so EVERY git operation authenticates as the right user.
 *
 * Why this exists:
 *  - Cloning embeds the token in remote.origin.url, which authenticates
 *    push/pull/fetch against `origin` for both providers. But that does NOT
 *    cover pi-initiated git ops against other remotes, submodules, or a repo
 *    whose remote URL lost its embedded credential.
 *  - GIT_ASKPASS is git's portable hook: git invokes it with a prompt like
 *    "Username for 'https://gitlab.com':" / "Password for '...'". We return the
 *    provider-correct username (GitHub: x-access-token, GitLab: oauth2) and the
 *    owner's stored token. This makes auth uniform regardless of how the remote
 *    URL was set.
 *
 * Username convention (HTTPS token auth):
 *   GitHub  → x-access-token   (GitHub requires this literal for PAT/OAuth tokens)
 *   GitLab  → oauth2           (GitLab's literal for OAuth/token auth)
 */
import { join } from "path";
import { writeFileSync, chmodSync } from "fs";
import { config } from "./config.mjs";
import db from "./db.mjs";
import { getSecretValue } from "./secrets.mjs";

const GITLAB_DEFAULT_HOST = "gitlab.com";

/** Secret key name a space/org can set to override the login-OAuth token. */
function secretKeyFor(provider) {
  if (provider === "github") return "GITHUB_TOKEN";
  if (provider === "gitlab") return "GITLAB_TOKEN";
  return null;
}

function safeHost(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Detect the git provider for a repo URL. Handles https, ssh, and SCP-like
 * (git@host:path) forms, plus self-hosted GitLab (matched against
 * config.gitlab.baseUrl).
 * Returns "github" | "gitlab" | null.
 */
export function providerForUrl(repoUrl = "") {
  if (!repoUrl) return null;
  const host = safeHost(repoUrl);
  const gitlabHost = safeHost(config.gitlab.baseUrl) || GITLAB_DEFAULT_HOST;

  // Explicit host match (covers https:// and ssh:// forms).
  if (host === "github.com") return "github";
  if (host === "gitlab.com" || host === gitlabHost) return "gitlab";

  // SCP-like form: git@github.com:org/repo.git  /  git@gitlab.example.com:...
  const scp = repoUrl.match(/^[\w.-]+@([\w.-]+):/);
  if (scp) {
    const h = scp[1].toLowerCase();
    if (h === "github.com") return "github";
    if (h === "gitlab.com" || h === gitlabHost) return "gitlab";
  }
  return null;
}

/** HTTPS token-auth username for a provider. */
export function usernameFor(provider) {
  if (provider === "github") return "x-access-token";
  if (provider === "gitlab") return "oauth2";
  return "oauth2";
}

/**
 * Resolve the credential for a space's repo work, based on the repo's provider
 * and the space OWNER's stored token. Returns null when we have no usable
 * token for that provider (public repo, SSH-only, or owner not linked).
 */
export function credsForOwner(repoUrl, ownerId) {
  const provider = providerForUrl(repoUrl);
  if (!provider) return null;
  const owner = db
    .prepare("SELECT github_token, gitlab_token FROM users WHERE id = ?")
    .get(ownerId);
  if (!owner) return null;
  const token = provider === "github" ? owner.github_token : owner.gitlab_token;
  if (!token) return null;
  return { provider, user: usernameFor(provider), token };
}

/**
 * Same as credsForOwner, resolved from a space id — but first gives the space
 * (and then its org) a chance to override the login-OAuth token with a
 * scoped secret. Precedence, per provider:
 *   1. space-scoped secret GITHUB_TOKEN / GITLAB_TOKEN for this space
 *   2. org-scoped secret GITHUB_TOKEN / GITLAB_TOKEN for the space's org
 *   3. the space owner's personal login-OAuth token (unchanged fallback)
 */
export function credsForSpace(spaceId) {
  const space = db
    .prepare("SELECT repo_url, owner_id, org_id FROM spaces WHERE id = ?")
    .get(spaceId);
  if (!space) return null;

  const provider = providerForUrl(space.repo_url);
  const keyName = secretKeyFor(provider);
  if (keyName) {
    const spaceSecret = getSecretValue({ scope: "space", spaceId, keyName });
    if (spaceSecret) return { provider, user: usernameFor(provider), token: spaceSecret };

    if (space.org_id) {
      const orgSecret = getSecretValue({ scope: "org", orgId: space.org_id, keyName });
      if (orgSecret) return { provider, user: usernameFor(provider), token: orgSecret };
    }
  }

  return credsForOwner(space.repo_url, space.owner_id);
}

/** Askpass env that authenticates any git op for these creds. Empty if none. */
export function askpassEnv(creds) {
  if (!creds?.token) return {};
  return {
    GIT_ASKPASS: config.gitAskpassPath,
    WAYNODE_GIT_USER: creds.user,
    WAYNODE_GIT_TOKEN: creds.token,
    // Never block on an interactive prompt inside the server/sandbox.
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Resolve askpass env from a repo working-tree path (used by git-ops writes). */
export function credsEnvForCwd(cwd) {
  if (!cwd) return {};
  const space = db
    .prepare("SELECT id FROM spaces WHERE local_path = ?")
    .get(cwd);
  if (!space) return {};
  return askpassEnv(credsForSpace(space.id));
}

/**
 * The askpass script git invokes. Reads WAYNODE_GIT_USER / WAYNODE_GIT_TOKEN
 * from the environment (set per-invocation by askpassEnv).
 *
 * git prompt shapes:
 *   "Username for 'https://gitlab.com':"
 *   "Password for 'https://oauth2@gitlab.com':"
 * `sername` matches Username only; `assword` matches Password only — no overlap.
 */
const ASKPASS_SCRIPT = `#!/bin/sh
# waynode git-askpass — non-interactive credential provider for git-over-HTTPS.
# Credentials are injected via WAYNODE_GIT_USER / WAYNODE_GIT_TOKEN env by the
# server. Never prompts; returns empty on unknown prompts.
case "$1" in
  *sername*) echo "$WAYNODE_GIT_USER" ;;
  *assword*) echo "$WAYNODE_GIT_TOKEN" ;;
  *) echo "" ;;
esac
`;

/** Write the askpass script to the data dir and make it executable. Idempotent. */
export function ensureGitAskpass() {
  try {
    writeFileSync(config.gitAskpassPath, ASKPASS_SCRIPT, { mode: 0o755 });
    chmodSync(config.gitAskpassPath, 0o755);
  } catch (err) {
    console.error("[git-creds] failed to write askpass script:", err.message);
  }
}
