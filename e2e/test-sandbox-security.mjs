/** Hosted sandbox credential boundary and fail-closed regression. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-sandbox-security-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "server-session-secret";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.LLM_API_KEY = "admin-key-must-stay-host-side";
process.env.PI_PROVIDER_API_KEY = "bootstrap-key-must-not-leak";

const { default: db } = await import("../lib/db.mjs");
const { setSecret } = await import("../lib/secrets.mjs");
const { buildHostedSandboxEnv, buildPiEnv } = await import("../lib/pi-env.mjs");
const { sandboxChatLlmEnv } = await import("../lib/sandbox-llm-key.mjs");
const {
  canFallbackToDirect,
  enforceHostedSandbox,
  enforceTerminalAvailability,
} = await import("../lib/pi-runner.mjs");

try {
  db.prepare("INSERT INTO users (id, name, email, github_token) VALUES (?, ?, ?, ?)")
    .run("owner", "Owner", "owner@example.test", "persistent-github-token");
  db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)")
    .run("org", "Org", "org");
  db.prepare(`
    INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("space", "org", "owner", "https://github.com/example/repo.git", "repo", root);
  setSecret({ scope: "space", spaceId: "space", keyName: "WORKTREE_SECRET", value: "stored-secret" });

  const trustedEnv = buildPiEnv("space", { ownerId: "owner" });
  assert.equal(trustedEnv.WORKTREE_SECRET, "stored-secret", "trusted execution keeps explicit worktree secrets");
  assert.equal(trustedEnv.WAYNODE_GIT_TOKEN, "persistent-github-token", "trusted execution keeps Git auth");

  const hostedEnv = buildHostedSandboxEnv({ ownerId: "owner" });
  assert.equal(hostedEnv.WORKTREE_SECRET, undefined, "hosted guest gets no stored worktree secret");
  assert.equal(hostedEnv.WAYNODE_GIT_TOKEN, undefined, "hosted guest gets no persistent Git token");
  assert.equal(hostedEnv.GIT_ASKPASS, undefined, "hosted guest gets no credential helper");
  assert.equal(hostedEnv.PI_PROVIDER_API_KEY, undefined, "hosted guest gets no provider bootstrap key");
  assert.equal(hostedEnv.LLM_API_KEY, undefined, "hosted guest gets no LLM admin key");
  assert.equal(hostedEnv.GIT_AUTHOR_EMAIL, "owner@example.test", "non-secret commit identity is preserved");
  assert.equal(Object.values(hostedEnv).includes("stored-secret"), false);
  assert.equal(Object.values(hostedEnv).includes("persistent-github-token"), false);

  const runtimeConfig = {
    deployment: "hosted",
    pi: { defaultProvider: "fornace", defaultModel: "fornace-fast" },
    llm: {
      baseUrl: "http://10.200.0.1:4000/v1",
      apiKey: "admin-key-must-stay-host-side",
      sandboxRuntimeKey: "restricted-runtime-key",
    },
  };
  const session = {
    id: "session", space_id: "space", owner_id: "owner",
    provider: "fornace", model: "fornace-fast",
  };
  const llmEnv = sandboxChatLlmEnv(session, runtimeConfig);
  assert.deepEqual(llmEnv, { WAYNODE_LLM_KEY: "restricted-runtime-key" });
  assert.equal(Object.values(llmEnv).includes(runtimeConfig.llm.apiKey), false, "admin key never enters sandbox env");
  assert.throws(
    () => sandboxChatLlmEnv(session, { ...runtimeConfig, llm: { ...runtimeConfig.llm, sandboxRuntimeKey: "" } }),
    /restricted runtime key is not configured/,
  );

  assert.throws(() => enforceHostedSandbox(false, "hosted"), /requires hardware sandboxing/);
  assert.doesNotThrow(() => enforceHostedSandbox(false, "self-hosted"));
  assert.equal(canFallbackToDirect("hosted"), false, "hosted failures never execute on the server host");
  assert.equal(canFallbackToDirect("self-hosted"), true, "trusted self-host keeps the development fallback");
  assert.throws(() => enforceTerminalAvailability("hosted"), /not available on Waynode Cloud/);
  assert.doesNotThrow(() => enforceTerminalAvailability("self-hosted"));

  const dockerfile = readFileSync(new URL("../sandbox/Dockerfile", import.meta.url), "utf8");
  assert.equal(dockerfile.match(/sk-[A-Za-z0-9_-]{12,}/g), null, "sandbox image contains no literal API credential");
  assert.match(dockerfile, /"apiKey": "\$WAYNODE_LLM_KEY"/, "sandbox provider config references runtime env");

  console.log("sandbox security regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
