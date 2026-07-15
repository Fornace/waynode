/** Provider-scoped, ephemeral credentials for trusted server-side git work. */
import { spawnSync } from "child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { isAbsolute, relative, sep } from "path";
import { config } from "./config.mjs";
import db from "./db.mjs";
import { getSecretValue } from "./secrets.mjs";
import { oauthTokenForUser } from "./oauth-tokens.mjs";

const GITLAB_DEFAULT_HOST = "gitlab.com";
const activeHostedGuests = new Map();
const activeTrustedGit = new Map();

function busyError(message) {
  const error = new Error(message);
  error.gitBusy = true;
  return error;
}

/** Block host-side Git while a guest can concurrently mutate its worktree. */
export function beginHostedGuestMutation(spaceId) {
  if (activeTrustedGit.has(spaceId)) {
    throw busyError("The hosted agent is waiting for an active Git operation to finish");
  }
  activeHostedGuests.set(spaceId, (activeHostedGuests.get(spaceId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeHostedGuests.get(spaceId) || 1) - 1;
    if (remaining > 0) activeHostedGuests.set(spaceId, remaining);
    else activeHostedGuests.delete(spaceId);
  };
}

/** Keep an asynchronous trusted Git child mutually exclusive with the guest. */
export function beginTrustedGitOperation(cwd) {
  const space = cwd && db.prepare("SELECT id FROM spaces WHERE local_path = ?").get(cwd);
  if (config.deployment !== "hosted" || !space) return () => {};
  if (activeHostedGuests.has(space.id)) {
    throw busyError("Git is temporarily unavailable while the hosted agent is modifying this worktree");
  }
  activeTrustedGit.set(space.id, (activeTrustedGit.get(space.id) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeTrustedGit.get(space.id) || 1) - 1;
    if (remaining > 0) activeTrustedGit.set(space.id, remaining);
    else activeTrustedGit.delete(space.id);
  };
}

function safeHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function secretKeyFor(provider) {
  if (provider === "github") return "GITHUB_TOKEN";
  if (provider === "gitlab") return "GITLAB_TOKEN";
  return null;
}

/** Detect the provider for HTTPS/SSH URLs and exact SCP-like git URLs. */
export function providerForUrl(repoUrl = "") {
  const host = safeHost(repoUrl);
  const gitlabHost = safeHost(config.gitlab.baseUrl) || GITLAB_DEFAULT_HOST;
  if (host === "github.com") return "github";
  if (host === "gitlab.com" || host === gitlabHost) return "gitlab";

  const at = repoUrl.indexOf("@");
  const colon = repoUrl.indexOf(":", at + 1);
  if (at > 0 && colon > at + 1 && !repoUrl.includes("://")) {
    const scpHost = repoUrl.slice(at + 1, colon).toLowerCase();
    if (scpHost === "github.com") return "github";
    if (scpHost === "gitlab.com" || scpHost === gitlabHost) return "gitlab";
  }
  return null;
}

export function usernameFor(provider) {
  if (provider === "github") return "x-access-token";
  if (provider === "gitlab") return "oauth2";
  return "oauth2";
}

/** Remove all URL-carried secrets. Used only for machine-structured URLs. */
export function publicRepoUrl(repoUrl) {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
    if (parsed.password) {
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {}
  return repoUrl;
}

/** Exact HTTPS credential scope, including repository path. */
export function credentialTargetForUrl(repoUrl) {
  try {
    const parsed = new URL(publicRepoUrl(repoUrl));
    if (parsed.protocol !== "https:" || parsed.search || parsed.hash) return null;
    let path = parsed.pathname;
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `https://${parsed.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

function safeCredentialPart(value) {
  return typeof value === "string" && value.length > 0
    && !value.includes("\0") && !value.includes("\r") && !value.includes("\n");
}

export function explicitCredentials(repoUrl, user, token) {
  const target = credentialTargetForUrl(repoUrl);
  if (!target || !safeCredentialPart(user) || !safeCredentialPart(token)) return null;
  return { provider: providerForUrl(repoUrl), user, token, target };
}

export function credsForOwner(repoUrl, ownerId) {
  const provider = providerForUrl(repoUrl);
  const target = credentialTargetForUrl(repoUrl);
  if (!provider || !target) return null;
  const token = oauthTokenForUser(db, ownerId, provider);
  if (!safeCredentialPart(token)) return null;
  return { provider, user: usernameFor(provider), token, target };
}

export function credsForSpace(spaceId) {
  const space = db.prepare("SELECT repo_url, owner_id, org_id FROM spaces WHERE id = ?").get(spaceId);
  if (!space) return null;
  const provider = providerForUrl(space.repo_url);
  const target = credentialTargetForUrl(space.repo_url);
  if (!provider || !target) return null;

  const keyName = secretKeyFor(provider);
  if (keyName) {
    const spaceSecret = getSecretValue({ scope: "space", spaceId, keyName });
    if (safeCredentialPart(spaceSecret)) {
      return { provider, user: usernameFor(provider), token: spaceSecret, target };
    }
    if (space.org_id) {
      const orgSecret = getSecretValue({ scope: "org", orgId: space.org_id, keyName });
      if (safeCredentialPart(orgSecret)) {
        return { provider, user: usernameFor(provider), token: orgSecret, target };
      }
    }
  }
  return credsForOwner(space.repo_url, space.owner_id);
}

const CREDENTIAL_CONFIG = [
  ["credential.helper", ""],
  ["credential.useHttpPath", "true"],
];
const HOSTED_HARDENING = [
  ["core.hooksPath", "/dev/null"],
  ["protocol.ext.allow", "never"],
  ["protocol.file.allow", "never"],
];

/** Environment for a trusted git child. Secrets exist only for its lifetime. */
export function askpassEnv(creds, { harden = false, denySsh = false } = {}) {
  if (!creds && !harden) return {};
  const gitConfig = [...CREDENTIAL_CONFIG, ...(harden ? HOSTED_HARDENING : [])];
  const env = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_PARAMETERS: "",
    GIT_CONFIG_COUNT: String(gitConfig.length),
    GIT_ASKPASS: config.gitAskpassPath,
    GIT_TERMINAL_PROMPT: "0",
    WAYNODE_GIT_USER: "",
    WAYNODE_GIT_TOKEN: "",
    WAYNODE_GIT_TARGET: "",
  };
  gitConfig.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (denySsh) {
    env.GIT_SSH = "/usr/bin/false";
    env.SSH_ASKPASS = "/usr/bin/false";
  }
  if (!creds?.token || !creds?.target) return env;
  return {
    ...env,
    WAYNODE_GIT_USER: creds.user,
    WAYNODE_GIT_TOKEN: creds.token,
    WAYNODE_GIT_TARGET: creds.target,
  };
}

export function credsEnvForCwd(cwd) {
  const space = cwd && db.prepare("SELECT id FROM spaces WHERE local_path = ?").get(cwd);
  const credentials = space ? credsForSpace(space.id) : null;
  const hosted = config.deployment === "hosted";
  return askpassEnv(credentials, { harden: hosted || !!credentials, denySsh: hosted || !!credentials });
}

const ASKPASS_SCRIPT = `#!/usr/bin/env node
const prompt = process.argv[2] || "";
const firstQuote = prompt.indexOf("'");
const lastQuote = prompt.lastIndexOf("'");
const kind = prompt.startsWith("Username for '") ? "user"
  : prompt.startsWith("Password for '") ? "token" : null;
if (!kind || firstQuote < 0 || lastQuote <= firstQuote) process.exit(0);
try {
  const url = new URL(prompt.slice(firstQuote + 1, lastQuote));
  url.username = "";
  url.password = "";
  if (url.protocol !== "https:" || url.search || url.hash) process.exit(0);
  let path = url.pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const target = \`https://\${url.host.toLowerCase()}\${path}\`;
  if (target !== process.env.WAYNODE_GIT_TARGET) process.exit(0);
  const value = kind === "user" ? process.env.WAYNODE_GIT_USER : process.env.WAYNODE_GIT_TOKEN;
  if (value && !value.includes("\\n") && !value.includes("\\r") && !value.includes("\\0")) {
    process.stdout.write(value);
  }
} catch {}
`;

export function ensureGitAskpass() {
  writeFileSync(config.gitAskpassPath, ASKPASS_SCRIPT, { mode: 0o755 });
  chmodSync(config.gitAskpassPath, 0o755);
  if (config.deployment === "hosted") {
    const spaces = db.prepare("SELECT id, local_path FROM spaces").all();
    for (const space of spaces) {
      if (!existsSync(`${space.local_path}${sep}.git`)) continue;
      try {
        enforceHostedGitCredentialBoundary(space.id);
      } catch {
        throw new Error(`Hosted Git credential boundary failed for space ${space.id}`);
      }
    }
  }
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function runConfig(cwd, args, allowedStatuses = [0]) {
  const result = spawnSync("git", ["-C", cwd, "config", "--local", "--no-includes", ...args], {
    encoding: "utf8", stdio: "pipe",
  });
  if (!allowedStatuses.includes(result.status)) throw new Error("Hosted worktree Git config is invalid");
  return result.stdout || "";
}

function localConfigEntries(cwd) {
  return runConfig(cwd, ["-z", "--list"]).split("\0").filter(Boolean).map((record) => {
    const separator = record.indexOf("\n");
    return separator < 0 ? [record, ""] : [record.slice(0, separator), record.slice(separator + 1)];
  });
}

function isAllowedHostedConfig(key) {
  const lower = key.toLowerCase();
  if ([
    "core.repositoryformatversion", "core.filemode", "core.bare",
    "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode",
    "remote.origin.url", "remote.origin.fetch",
  ].includes(lower)) return true;
  if (!lower.startsWith("branch.")) return false;
  const settingSeparator = lower.lastIndexOf(".");
  const branchName = lower.slice("branch.".length, settingSeparator);
  const setting = lower.slice(settingSeparator + 1);
  return !!branchName && ["remote", "merge", "rebase"].includes(setting);
}

/** Scrub legacy credentials and fail closed before a hosted worktree is mounted. */
export function enforceHostedGitCredentialBoundary(spaceId) {
  const space = db.prepare(`
    SELECT repo_url, repo_full_name, local_path, owner_id, org_id
    FROM spaces WHERE id = ?
  `).get(spaceId);
  if (!space) throw new Error("Space not found");
  const root = realpathSync(space.local_path);
  const gitDirResult = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
  if (gitDirResult.status !== 0) throw new Error("Hosted worktree is not a valid Git repository");
  const gitDir = realpathSync(gitDirResult.stdout.trim());
  if (!inside(root, gitDir)) throw new Error("Hosted worktree Git directory must remain inside the workspace");
  const configPath = `${gitDir}${sep}config`;
  if (!existsSync(configPath) || !inside(gitDir, realpathSync(configPath))) {
    throw new Error("Hosted worktree Git config must remain inside the repository");
  }

  const cleanRepoUrl = publicRepoUrl(space.repo_url);
  if (!credentialTargetForUrl(cleanRepoUrl) && safeHost(cleanRepoUrl)) {
    throw new Error("Hosted token authentication requires a credential-free HTTPS repository URL");
  }
  if (cleanRepoUrl !== space.repo_url || publicRepoUrl(space.repo_full_name) !== space.repo_full_name) {
    db.prepare("UPDATE spaces SET repo_url = ?, repo_full_name = ? WHERE id = ?")
      .run(cleanRepoUrl, publicRepoUrl(space.repo_full_name), spaceId);
  }

  const knownTokens = [
    oauthTokenForUser(db, space.owner_id, "github"),
    oauthTokenForUser(db, space.owner_id, "gitlab"),
  ];
  for (const keyName of ["GITHUB_TOKEN", "GITLAB_TOKEN"]) {
    knownTokens.push(getSecretValue({ scope: "space", spaceId, keyName }));
    if (space.org_id) knownTokens.push(getSecretValue({ scope: "org", orgId: space.org_id, keyName }));
  }
  const providerTokens = knownTokens.filter(safeCredentialPart);
  for (const [key] of localConfigEntries(root)) {
    if (!isAllowedHostedConfig(key)) runConfig(root, ["--unset-all", key], [0, 5]);
  }
  runConfig(root, ["--replace-all", "core.repositoryFormatVersion", "0"]);
  runConfig(root, ["--replace-all", "core.bare", "false"]);
  runConfig(root, ["--replace-all", "core.logAllRefUpdates", "true"]);
  runConfig(root, ["--replace-all", "remote.origin.url", cleanRepoUrl]);
  runConfig(root, ["--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);

  const configText = readFileSync(configPath, "utf8");
  if (providerTokens.some((token) => configText.includes(token))) {
    throw new Error("Hosted worktree Git config contains a provider credential");
  }
  return { repoUrl: cleanRepoUrl, gitDir };
}

/** Full trusted-child environment, with a fresh hosted config scrub per call. */
export function trustedGitEnvForCwd(cwd, { auth = false } = {}) {
  const space = cwd && db.prepare("SELECT id FROM spaces WHERE local_path = ?").get(cwd);
  const hosted = config.deployment === "hosted";
  if (hosted && space && activeHostedGuests.has(space.id)) {
    throw busyError("Git is temporarily unavailable while the hosted agent is modifying this worktree");
  }
  if (hosted && space) enforceHostedGitCredentialBoundary(space.id);
  const credentials = auth && space ? credsForSpace(space.id) : null;
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  Object.assign(env, {
    GIT_EDITOR: "/usr/bin/true",
    GIT_SEQUENCE_EDITOR: "/usr/bin/true",
    GIT_PAGER: "cat",
    ...askpassEnv(credentials, { harden: hosted, denySsh: hosted }),
  });
  if (hosted) {
    env.GIT_SSH_COMMAND = "/usr/bin/false";
    env.GIT_PROXY_COMMAND = "/usr/bin/false";
  }
  return env;
}
