/**
 * lib/pi-config.mjs — writes pi's fornace LLM provider config at process
 * startup, from runtime env vars (LLM_BASE_URL / LLM_API_KEY), instead of
 * baking the API key into a Docker image layer.
 *
 * Why this exists: neither the sandbox image nor the main server image may
 * bake an LLM key into a layer. Hosted sandboxes receive only a separately
 * provisioned, restricted virtual key (see sandbox-llm-key.mjs). The main Waynode image
 * has no guest network boundary, and a key baked into a `RUN`/`ENV` layer is
 * inspectable by anyone with the image (including via `docker history` and
 * `docker save` + layer extraction). So for this image, the key must be
 * supplied at container runtime — same pattern as SESSION_SECRET/
 * ENCRYPTION_KEY (env_file in docker-compose.yml) and the git-askpass helper
 * (lib/git-creds.mjs's ensureGitAskpass, which writes a runtime-secret file
 * from process.env instead of a build-time COPY).
 */
import { writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { config } from "./config.mjs";

const MODEL_CATALOG = [
  { id: "fornace-fast", name: "Fornace Fast" },
  { id: "fornace-reasoning", name: "Fornace Reasoning" },
  { id: "fornace-max", name: "Fornace Max" },
  { id: "glm-5.2-fast", name: "GLM 5.2 Fast" },
  { id: "glm-5.2-reasoning", name: "GLM 5.2 Reasoning" },
  { id: "qwen-flash", name: "Qwen Flash" },
];

/**
 * Write /root/.pi/agent/models.json (or ~/.pi/agent/models.json outside
 * Docker) pointing pi at the fornace LLM gateway, using config.llm.baseUrl /
 * config.llm.apiKey (LLM_BASE_URL / LLM_API_KEY env vars). No-ops quietly if
 * LLM_API_KEY isn't set — pi simply won't have the fornace provider
 * configured, same as any other optional integration.
 */
export function ensurePiProviderConfig() {
  if (config.pi.defaultProvider !== "fornace") return;
  if (!config.llm.apiKey) {
    console.warn("[pi-config] LLM_API_KEY not set — skipping fornace provider config for pi");
    return;
  }
  try {
    const piAgentDir = join(homedir(), ".pi", "agent");
    mkdirSync(piAgentDir, { recursive: true });
    const modelsJson = {
      providers: {
        fornace: {
          baseUrl: `http://${config.llm.baseUrl.replace(/^https?:\/\//, "")}/v1`,
          api: "openai-completions",
          apiKey: config.llm.apiKey,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: MODEL_CATALOG,
        },
      },
    };
    writeFileSync(join(piAgentDir, "models.json"), JSON.stringify(modelsJson, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[pi-config] failed to write pi provider config:", err.message);
  }
}
