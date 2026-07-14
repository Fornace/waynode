import { config } from "./config.mjs";
import { providerCredentialKey, resolvePiModel } from "./pi-model.mjs";
import { ensureGlobalSecret } from "./secrets.mjs";

/**
 * One-time self-host bootstrap. The key is encrypted in SQLite before any
 * agent starts, then removed from process.env so spawned agents can receive it
 * only through the scoped secret resolver. Hosted deployments never use this.
 */
export function bootstrapSelfHostedProviderCredential(env = process.env) {
  if (config.deployment !== "self-hosted") return { status: "disabled" };
  let keyName;
  try {
    const { provider } = resolvePiModel();
    keyName = providerCredentialKey(provider);
    if (!keyName) return { status: "unsupported", provider };

    const value = env.PI_PROVIDER_API_KEY || env[keyName];
    if (!value) return { status: "missing", provider, keyName };
    const created = ensureGlobalSecret(keyName, value);
    return { status: created ? "created" : "exists", provider, keyName };
  } finally {
    // The generic bootstrap name is never useful to pi itself. Clear it even
    // when the provider is unsupported or configuration validation fails.
    delete env.PI_PROVIDER_API_KEY;
    if (keyName) delete env[keyName];
  }
}
