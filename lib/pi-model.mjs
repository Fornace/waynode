import { config } from "./config.mjs";

const FORNACE_MODELS = [
  { id: "fornace-fast", name: "Fornace Fast", desc: "Quick responses, lower cost" },
  { id: "fornace-reasoning", name: "Fornace Reasoning", desc: "Balanced quality and speed" },
  { id: "fornace-max", name: "Fornace Max", desc: "Best quality, slower" },
  { id: "fornace-vision", name: "Fornace Vision", desc: "Image understanding" },
  { id: "glm-5.2-fast", name: "GLM 5.2 Fast", desc: "Zhipu GLM fast" },
  { id: "glm-5.2-reasoning", name: "GLM 5.2 Reasoning", desc: "Zhipu GLM reasoning" },
  { id: "glm-5.2-max", name: "GLM 5.2 Max", desc: "Zhipu GLM max quality" },
  { id: "qwen-flash", name: "Qwen Flash", desc: "Alibaba Qwen fast" },
];

const PROVIDER_CREDENTIAL_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
};

/** Return the provider-local id plus the single model spec pi expects. */
export function resolvePiModel(session = {}, defaults = config.pi) {
  const provider = String(session.provider || defaults.defaultProvider || "").trim();
  const configuredModel = String(session.model || defaults.defaultModel || "").trim();
  if (!provider) throw new Error("A pi provider must be configured");
  if (!configuredModel) throw new Error("A pi model must be configured");

  // Persisted models are provider-local. Tolerate a matching prefix in env or
  // legacy rows, but never blindly split: OpenRouter model ids contain slashes.
  const prefix = `${provider}/`;
  const model = configuredModel.startsWith(prefix)
    ? configuredModel.slice(prefix.length)
    : configuredModel;
  if (!model) throw new Error("A pi model must be configured");
  return { provider, model, spec: `${provider}/${model}` };
}

export function providerCredentialKey(provider) {
  return PROVIDER_CREDENTIAL_KEYS[provider] || null;
}

export function configuredModelCatalog(defaults = config.pi) {
  const selected = resolvePiModel({}, defaults);
  const models = selected.provider === "fornace"
    ? FORNACE_MODELS
    : [{
        id: selected.model,
        name: selected.model,
        desc: `Configured ${selected.provider} model`,
      }];
  return models.map((model) => ({ ...model, provider: selected.provider }));
}
