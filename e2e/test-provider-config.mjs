/** Self-host provider selection and encrypted-secret isolation regression. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-provider-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "server-only-session-secret";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.PI_DEFAULT_PROVIDER = "openai";
process.env.PI_DEFAULT_MODEL = "openai/gpt-4.1";
process.env.OPENAI_API_KEY = "process-key-must-not-leak";
process.env.ANTHROPIC_API_KEY = "another-process-key-must-not-leak";
process.env.SERVER_ONLY_SECRET = "must-not-leak";
process.env.PI_PROVIDER_API_KEY = "bootstrap-global-key";

const { default: db } = await import("../lib/db.mjs");
const { buildPiEnv, getPiArgs } = await import("../lib/pi-runner.mjs");
const { configuredModelCatalog, providerCredentialKey, resolvePiModel } = await import("../lib/pi-model.mjs");
const { getSecretsEnv, setSecret } = await import("../lib/secrets.mjs");
const { bootstrapSelfHostedProviderCredential } = await import("../lib/pi-provider-bootstrap.mjs");

try {
  db.prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)")
    .run("owner", "Owner", "owner@example.test");
  db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)")
    .run("org-a", "Org A", "org-a");
  db.prepare("INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)")
    .run("org-b", "Org B", "org-b");
  const addSpace = db.prepare(`
    INSERT INTO spaces (id, org_id, owner_id, repo_url, repo_name, local_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  addSpace.run("space-a1", "org-a", "owner", "https://example.test/a1.git", "a1", root);
  addSpace.run("space-a2", "org-a", "owner", "https://example.test/a2.git", "a2", root);
  addSpace.run("space-b1", "org-b", "owner", "https://example.test/b1.git", "b1", root);

  assert.deepEqual(resolvePiModel({ provider: "anthropic", model: "claude-sonnet-4" }), {
    provider: "anthropic",
    model: "claude-sonnet-4",
    spec: "anthropic/claude-sonnet-4",
  });
  assert.equal(resolvePiModel().spec, "openai/gpt-4.1", "matching default prefix is not doubled");
  assert.deepEqual(configuredModelCatalog(), [{
    id: "gpt-4.1",
    name: "gpt-4.1",
    desc: "Configured openai model",
    provider: "openai",
  }]);
  assert.equal(providerCredentialKey("openrouter"), "OPENROUTER_API_KEY");

  const args = getPiArgs({
    session: { provider: "openai", model: "openai/gpt-4.1", pi_session_dir: root },
    prompt: "hello",
    isGoal: false,
  });
  assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-4.1");

  assert.equal(bootstrapSelfHostedProviderCredential().status, "created");
  assert.equal(process.env.PI_PROVIDER_API_KEY, undefined, "bootstrap key is removed from process env");
  assert.equal(process.env.OPENAI_API_KEY, undefined, "provider-specific fallback is removed too");
  assert.equal(getSecretsEnv("space-a1").OPENAI_API_KEY, "bootstrap-global-key", "bootstrap key is encrypted globally");
  const stored = db.prepare("SELECT encrypted_value FROM secrets WHERE scope = 'global' AND key_name = ?").get("OPENAI_API_KEY");
  assert.notEqual(stored.encrypted_value, "bootstrap-global-key", "bootstrap key is not stored as plaintext");
  assert.equal(bootstrapSelfHostedProviderCredential({ PI_PROVIDER_API_KEY: "replacement" }).status, "exists", "restart never overwrites the encrypted key");
  setSecret({ scope: "org", orgId: "org-a", keyName: "OPENAI_API_KEY", value: "org-a-key" });
  setSecret({ scope: "org", orgId: "org-b", keyName: "OPENAI_API_KEY", value: "org-b-key" });
  setSecret({ scope: "space", spaceId: "space-a1", keyName: "OPENAI_API_KEY", value: "space-a1-key" });

  assert.equal(getSecretsEnv("space-a1").OPENAI_API_KEY, "space-a1-key", "worktree overrides org and global");
  assert.equal(getSecretsEnv("space-a2").OPENAI_API_KEY, "org-a-key", "owning org secret reaches its worktrees");
  assert.equal(getSecretsEnv("space-b1").OPENAI_API_KEY, "org-b-key", "org secrets do not cross organizations");

  process.env.PI_PROVIDER_API_KEY = "late-key-must-not-leak";
  const env = buildPiEnv("space-a1", { ownerId: "owner" });
  assert.equal(env.OPENAI_API_KEY, "space-a1-key", "encrypted worktree key reaches pi");
  assert.equal(env.PI_PROVIDER_API_KEY, undefined, "bootstrap variable is explicitly denied to pi");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "process provider keys are not inherited");
  assert.equal(env.SESSION_SECRET, undefined, "server session secret is isolated");
  assert.equal(env.ENCRYPTION_KEY, undefined, "encryption master key is isolated");
  assert.equal(env.SERVER_ONLY_SECRET, undefined, "arbitrary server secrets are isolated");
  console.log("self-host provider config: 20 assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
