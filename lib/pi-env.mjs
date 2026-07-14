import { getSecretsEnv } from "./secrets.mjs";
import { identityForUserId } from "./git-identity.mjs";
import { credsForSpace, askpassEnv } from "./git-creds.mjs";

/**
 * pi runs arbitrary worktree code. Start from an allowlist so server secrets
 * such as SESSION_SECRET, ENCRYPTION_KEY, OAuth secrets and LLM admin keys do
 * not cross the process boundary accidentally.
 */
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "SHELL",
];
const ENV_PREFIX_ALLOW = ["PI_", "LEAN_CTX_"];
const ENV_DENY = new Set(["PI_PROVIDER_API_KEY"]);

function minimalBaseEnv({ includeToolPrefixes = true } = {}) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined && process.env[key] !== "") env[key] = process.env[key];
  }
  if (includeToolPrefixes) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!ENV_DENY.has(key) && ENV_PREFIX_ALLOW.some((prefix) => key.startsWith(prefix))) {
        env[key] = value;
      }
    }
  }
  env.HOME = env.HOME || "/root";
  return env;
}

function addGitIdentity(env, ownerId) {
  const identity = identityForUserId(ownerId);
  env.GIT_AUTHOR_NAME = identity.name;
  env.GIT_AUTHOR_EMAIL = identity.email;
  env.GIT_COMMITTER_NAME = identity.name;
  env.GIT_COMMITTER_EMAIL = identity.email;
  return env;
}

/** Trusted direct/self-host execution retains explicitly configured secrets. */
export function buildPiEnv(spaceId, { ownerId } = {}) {
  const env = addGitIdentity({ ...minimalBaseEnv(), ...getSecretsEnv(spaceId) }, ownerId);
  Object.assign(env, askpassEnv(credsForSpace(spaceId)));
  return env;
}

/** Hosted microVMs receive no stored secrets or persistent Git credentials. */
export function buildHostedSandboxEnv({ ownerId } = {}) {
  return addGitIdentity(minimalBaseEnv({ includeToolPrefixes: false }), ownerId);
}
