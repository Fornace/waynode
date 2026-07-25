import { config } from "./config.mjs";
import { resolvePiModel } from "./pi-model.mjs";
import { getSecretValue } from "./secrets.mjs";
import { ensureOrgHammersmithKey, ensureOrgLlmKey, HAMMERSMITH_LLM_KEY } from "./org-llm-key.mjs";

export const HAMMERSMITH_WORKER_KEY = HAMMERSMITH_LLM_KEY;

/**
 * Return the LLM environment allowed into a one-shot sandboxed chat.
 *
 * Hosted Waynode accepts only a separately provisioned, restricted runtime
 * virtual key. The gateway admin key must never be configured here: Waynode
 * cannot safely mint child keys while also guaranteeing that an admin key is
 * absent from its process and deployment environment.
 */
export async function sandboxChatLlmEnv(session, runtimeConfig = config, { orgId = null } = {}) {
  const { provider } = resolvePiModel(session, runtimeConfig.pi);

  if (provider !== "fornace") {
    if (runtimeConfig.deployment === "hosted") {
      throw new Error("Hosted sandboxes require the managed Waynode model provider");
    }
    return {};
  }

  if (runtimeConfig.deployment === "hosted") {
    // Prefer the org's own gateway key (per-org isolation, revocation, and
    // gateway-side budget). Any minting failure falls back to the shared
    // restricted runtime key so a gateway-admin hiccup never blocks work.
    try {
      const orgKey = await ensureOrgLlmKey(orgId, { runtimeConfig });
      if (orgKey) return { WAYNODE_LLM_KEY: orgKey };
    } catch (error) {
      console.warn(`[org-llm-key] falling back to shared runtime key for org ${orgId}:`, error.message);
    }
    const key = runtimeConfig.llm.sandboxRuntimeKey;
    if (!key) {
      throw new Error("Hosted sandbox chat is unavailable: restricted runtime key is not configured");
    }
    return { WAYNODE_LLM_KEY: key };
  }

  if (!runtimeConfig.llm.apiKey) return {};
  return { WAYNODE_LLM_KEY: runtimeConfig.llm.apiKey };
}

/**
 * Hosted Hammersmith workers get only an encrypted tenant-scoped credential.
 * The deployment-wide chat runtime key is intentionally never a fallback.
 *
 * Resolution order:
 *   1. A Space-scoped secret — an explicit per-Space credential wins outright.
 *   2. The org's own gateway key, minted (or rotated) on demand, so an entitled
 *      org can start its first run without an operator planting a secret. This
 *      is the path a paying customer takes.
 *   3. A previously stored org secret, if minting is unavailable right now
 *      (gateway hiccup) — the run proceeds on the last good tenant key.
 * Nothing else: with no tenant credential this still fails closed with a 503.
 */
export async function hammersmithWorkerLlmEnv(session, opts = {}) {
  const spaceKey = getSecretValue({
    scope: "space", spaceId: session.space_id, keyName: HAMMERSMITH_WORKER_KEY,
  });
  if (spaceKey) return { WAYNODE_LLM_KEY: spaceKey };

  if (session.org_id) {
    try {
      const minted = await ensureOrgHammersmithKey(session.org_id, opts);
      if (minted) return { WAYNODE_LLM_KEY: minted };
    } catch (error) {
      console.warn(
        `[hammersmith-llm-key] mint failed for org ${session.org_id}, trying stored key:`,
        error.message,
      );
    }
    const orgKey = getSecretValue({
      scope: "org", orgId: session.org_id, keyName: HAMMERSMITH_WORKER_KEY,
    });
    if (orgKey) return { WAYNODE_LLM_KEY: orgKey };
  }

  const error = new Error(
    `Hosted Hammersmith requires an encrypted Space or organization ${HAMMERSMITH_WORKER_KEY} secret`,
  );
  error.status = 503;
  throw error;
}
