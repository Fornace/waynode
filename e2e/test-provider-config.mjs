/** Self-host provider selection and encrypted-secret isolation regression. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-provider-"));
const dataDir = join(root, "waynode-data");
const operatorHome = join(root, "operator-home");
const operatorAgentDir = join(operatorHome, ".pi", "agent");
const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = operatorHome;
process.env.DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = operatorAgentDir;
process.env.SESSION_SECRET = "server-only-session-secret";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.PI_DEFAULT_PROVIDER = "openai";
process.env.PI_DEFAULT_MODEL = "openai/gpt-4.1";
process.env.OPENAI_API_KEY = "process-key-must-not-leak";
process.env.ANTHROPIC_API_KEY = "another-process-key-must-not-leak";
process.env.SERVER_ONLY_SECRET = "must-not-leak";
process.env.PI_PROVIDER_API_KEY = "bootstrap-global-key";
process.env.LLM_BASE_URL = "https://llm.fornace.test/";
process.env.LLM_API_KEY = "test-only-provider-key";

const { config } = await import("../lib/config.mjs");
const { default: db } = await import("../lib/db.mjs");
const { AgentHandle, getAgentRpcArgs } = await import("../lib/agent-rpc-handle.mjs");
const { buildPiEnv, embeddedPiResourceArgs, getPiArgs } = await import("../lib/pi-runner.mjs");
const { configuredModelCatalog, providerCredentialKey, resolvePiModel } = await import("../lib/pi-model.mjs");
const { ensurePiProviderConfig, normalizePiProviderBaseUrl, piAgentDir } = await import("../lib/pi-config.mjs");
const { getSecret, getSecretsEnv, setSecret } = await import("../lib/secrets.mjs");
const { bootstrapSelfHostedProviderCredential } = await import("../lib/pi-provider-bootstrap.mjs");

try {
  const restDriver = readFileSync(new URL("./run-rest.mjs", import.meta.url), "utf8");
  assert.ok(restDriver.includes('new Set(["auth", "open-session", ...process.env.ONLY.split(",")])'), "isolated chat selection retains its auth/session prerequisites");
  const goalExtensionDir = join(operatorAgentDir, "npm", "node_modules", "pi-codex-goal", "src");
  const goalExtension = join(goalExtensionDir, "index.ts");
  mkdirSync(goalExtensionDir, { recursive: true });
  writeFileSync(goalExtension, "// test extension\n");
  writeFileSync(join(operatorAgentDir, "auth.json"), '{"operator":"auth"}\n');
  writeFileSync(join(operatorAgentDir, "settings.json"), '{"operator":"settings"}\n');
  writeFileSync(join(operatorAgentDir, "models.json"), '{"operator":"models"}\n');
  const resourceArgs = embeddedPiResourceArgs();
  const resourceIsolationFlags = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
  for (const flag of resourceIsolationFlags) {
    assert.ok(resourceArgs.includes(flag), `embedded pi isolates ambient resources with ${flag}`);
  }
  assert.equal(resourceArgs.filter((arg) => arg === "--extension").length, 1, "embedded pi restores exactly one extension");
  assert.equal(resourceArgs[resourceArgs.indexOf("--extension") + 1], goalExtension, "only the goal extension is explicitly restored");
  const rpcArgs = getAgentRpcArgs({ id: "rpc-session", provider: "openai", model: "gpt-4.1", pi_session_dir: root });
  for (const flag of resourceIsolationFlags) {
    assert.ok(rpcArgs.includes(flag), `long-lived RPC chat isolates ambient resources with ${flag}`);
  }
  assert.equal(rpcArgs.includes("--no-tools"), false, "ordinary RPC messages retain normal and goal tools");
  assert.equal(rpcArgs[rpcArgs.indexOf("--session-id") + 1], "rpc-session", "new RPC sessions use the stable Waynode ID");
  assert.equal(rpcArgs[rpcArgs.indexOf("--extension") + 1], goalExtension, "long-lived RPC chat preserves goal tools");
  const rpcHandle = new AgentHandle({ id: "rpc-session", space_id: "rpc-space", title: "RPC" });
  let firstTurnCommand = null;
  rpcHandle._send = async (command) => { firstTurnCommand = command; };
  const firstTurn = rpcHandle.sendPrompt("ordinary message", "message", "rpc-submission");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(firstTurnCommand, { type: "prompt", message: "ordinary message" }, "ordinary first turns use the RPC prompt command without rewriting content");
  rpcHandle.submissions.settle(rpcHandle.currentSubmission, "completed");
  await firstTurn;
  let turnProbeCount = 0;
  const cleanupTurnProbe = rpcHandle.subscribe((event) => {
    if (event.type === "turn-probe") turnProbeCount += 1;
  });
  rpcHandle.broadcast({ type: "turn-probe" });
  assert.equal(turnProbeCount, 1, "a subscribed turn probe receives a broadcast");
  cleanupTurnProbe();
  assert.equal(rpcHandle.subscribers.size, 0, "subscriber cleanup immediately removes the turn probe");
  rpcHandle.broadcast({ type: "turn-probe" });
  assert.equal(turnProbeCount, 1, "an unsubscribed turn probe does not receive later broadcasts");

  assert.equal(normalizePiProviderBaseUrl("https://llm.fornace.net"), "https://llm.fornace.net/v1");
  assert.equal(normalizePiProviderBaseUrl("http://llm.fornace.net"), "http://llm.fornace.net/v1");
  assert.equal(normalizePiProviderBaseUrl("llm.fornace.net"), "http://llm.fornace.net/v1");
  assert.equal(normalizePiProviderBaseUrl("https://llm.fornace.net/"), "https://llm.fornace.net/v1");
  assert.equal(normalizePiProviderBaseUrl("https://llm.fornace.net/v1"), "https://llm.fornace.net/v1");

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
  assert.equal(providerCredentialKey("fornace"), "FORNACE_API_KEY");
  assert.equal(providerCredentialKey("openrouter"), "OPENROUTER_API_KEY");

  const args = getPiArgs({
    session: { id: "waynode-session", provider: "openai", model: "openai/gpt-4.1", pi_session_dir: root },
    prompt: "hello",
    isGoal: false,
  });
  assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-4.1");
  assert.ok(args.includes("--no-approve"), "headless agents never wait for project trust input");
  assert.ok(args.includes("--no-extensions"), "one-shot chat also isolates ambient extensions");
  assert.equal(args.includes("--no-tools"), false, "one-shot ordinary messages retain normal and goal tools");
  assert.equal(args[args.indexOf("--extension") + 1], goalExtension, "one-shot chat preserves goal tools");
  assert.equal(args[args.indexOf("--session-id") + 1], "waynode-session", "new sessions receive a stable pi session ID");
  const goalArgs = getPiArgs({
    session: { id: "goal-session", provider: "openai", model: "gpt-4.1", pi_session_dir: root },
    prompt: "finish the task",
    mode: "goal",
  });
  assert.ok(goalArgs[goalArgs.indexOf("-p") + 1].includes("create_goal"), "goal mode still requests the create_goal lifecycle");
  writeFileSync(join(root, "historic.jsonl"), "");
  const historicArgs = getPiArgs({
    session: { id: "waynode-session", provider: "openai", model: "gpt-4.1", pi_session_dir: root },
    prompt: "continue",
    isGoal: false,
  });
  assert.ok(historicArgs.includes("--continue"), "historic pi sessions retain their original generated ID");

  assert.equal(bootstrapSelfHostedProviderCredential().status, "created");
  assert.equal(process.env.PI_PROVIDER_API_KEY, undefined, "bootstrap key is removed from process env");
  assert.equal(process.env.OPENAI_API_KEY, undefined, "provider-specific fallback is removed too");
  assert.equal(getSecretsEnv("space-a1").OPENAI_API_KEY, "bootstrap-global-key", "bootstrap key is encrypted globally");
  const stored = db.prepare("SELECT encrypted_value FROM secrets WHERE scope = 'global' AND key_name = ?").get("OPENAI_API_KEY");
  assert.notEqual(stored.encrypted_value, "bootstrap-global-key", "bootstrap key is not stored as plaintext");
  assert.equal(bootstrapSelfHostedProviderCredential({ PI_PROVIDER_API_KEY: "replacement" }).status, "exists", "restart never overwrites the encrypted key");
  const orgSecret = setSecret({ scope: "org", orgId: "org-a", keyName: "OPENAI_API_KEY", value: "org-a-key" });
  setSecret({ scope: "org", orgId: "org-b", keyName: "OPENAI_API_KEY", value: "org-b-key" });
  setSecret({ scope: "space", spaceId: "space-a1", keyName: "OPENAI_API_KEY", value: "space-a1-key" });

  assert.equal(getSecretsEnv("space-a1").OPENAI_API_KEY, "space-a1-key", "worktree overrides org and global");
  assert.equal(getSecret(orgSecret.id).org_id, "org-a", "org secret lookup retains its authorization scope");
  assert.equal(getSecretsEnv("space-a2").OPENAI_API_KEY, "org-a-key", "owning org secret reaches its worktrees");
  assert.equal(getSecretsEnv("space-b1").OPENAI_API_KEY, "org-b-key", "org secrets do not cross organizations");

  process.env.PI_PROVIDER_API_KEY = "late-key-must-not-leak";
  const env = buildPiEnv("space-a1", { ownerId: "owner" });
  const serverAgentDir = piAgentDir();
  assert.equal(serverAgentDir, join(dataDir, "pi-agent"), "Pi config lives under Waynode DATA_DIR");
  assert.notEqual(serverAgentDir, operatorAgentDir, "server Pi config is separate from the operator config");
  assert.equal(env.PI_CODING_AGENT_DIR, serverAgentDir, "embedded Pi child receives the server-owned config directory");
  assert.notEqual(env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR, "ambient operator PI_CODING_AGENT_DIR is not inherited");
  assert.equal(env.OPENAI_API_KEY, "space-a1-key", "encrypted worktree key reaches pi");
  assert.equal(env.PI_PROVIDER_API_KEY, undefined, "bootstrap variable is explicitly denied to pi");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "process provider keys are not inherited");
  assert.equal(env.SESSION_SECRET, undefined, "server session secret is isolated");
  assert.equal(env.ENCRYPTION_KEY, undefined, "encryption master key is isolated");
  assert.equal(env.SERVER_ONLY_SECRET, undefined, "arbitrary server secrets are isolated");

  config.pi.defaultProvider = "fornace";
  ensurePiProviderConfig();
  const generatedModelsPath = join(serverAgentDir, "models.json");
  const generatedModels = JSON.parse(readFileSync(generatedModelsPath, "utf8"));
  assert.equal(statSync(generatedModelsPath).mode & 0o777, 0o600, "generated models.json has mode 0600");
  assert.equal(readFileSync(join(operatorAgentDir, "models.json"), "utf8"), '{"operator":"models"}\n', "operator models.json is untouched");
  assert.equal(existsSync(join(serverAgentDir, "auth.json")), false, "server config does not inherit operator auth");
  assert.equal(existsSync(join(serverAgentDir, "settings.json")), false, "server config does not inherit operator settings");
  assert.deepEqual(generatedModels.providers.fornace, {
    baseUrl: "https://llm.fornace.test/v1",
    api: "openai-completions",
    apiKey: "test-only-provider-key",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
    models: [
      { id: "fornace-fast", name: "Fornace Fast" },
      { id: "fornace-reasoning", name: "Fornace Reasoning" },
      { id: "fornace-max", name: "Fornace Max" },
      { id: "glm-5.2-fast", name: "GLM 5.2 Fast" },
      { id: "glm-5.2-reasoning", name: "GLM 5.2 Reasoning" },
      { id: "qwen-flash", name: "Qwen Flash" },
    ],
  });
  const listModels = spawnSync("pi", [
    "--list-models", "fornace-fast",
    ...resourceIsolationFlags,
  ], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: serverAgentDir, PI_TELEMETRY: "0" },
    timeout: 10_000,
  });
  assert.equal(listModels.status, 0, `installed pi accepts the sparse model catalog: ${listModels.stderr.trim()}`);
  assert.ok(listModels.stdout.includes("fornace-fast"), "installed pi lists a sparse model entry using documented defaults");
  console.log("self-host provider config: resource isolation and provider assertions passed");
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  rmSync(root, { recursive: true, force: true });
}
