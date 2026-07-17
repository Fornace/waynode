import { config } from "./config.mjs";
import { resolvePiModel } from "./pi-model.mjs";
import { getSecretValue } from "./secrets.mjs";

export const HAMMERSMITH_WORKER_KEY = "HAMMERSMITH_LLM_KEY";

/**
 * Return the LLM environment allowed into a one-shot sandboxed chat.
 *
 * Hosted Waynode accepts only a separately provisioned, restricted runtime
 * virtual key. The gateway admin key must never be configured here: Waynode
 * cannot safely mint child keys while also guaranteeing that an admin key is
 * absent from its process and deployment environment.
 */
export function sandboxChatLlmEnv(session, runtimeConfig = config) {
  const { provider } = resolvePiModel(session, runtimeConfig.pi);

  if (provider !== "fornace") {
    if (runtimeConfig.deployment === "hosted") {
      throw new Error("Hosted sandboxes require the managed Waynode model provider");
    }
    return {};
  }

  if (runtimeConfig.deployment === "hosted") {
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
 */
export function hammersmithWorkerLlmEnv(session) {
  const spaceKey = getSecretValue({
    scope: "space", spaceId: session.space_id, keyName: HAMMERSMITH_WORKER_KEY,
  });
  const orgKey = !spaceKey && session.org_id ? getSecretValue({
    scope: "org", orgId: session.org_id, keyName: HAMMERSMITH_WORKER_KEY,
  }) : null;
  const key = spaceKey || orgKey;
  if (!key) {
    const error = new Error(
      `Hosted Hammersmith requires an encrypted Space or organization ${HAMMERSMITH_WORKER_KEY} secret`,
    );
    error.status = 503;
    throw error;
  }
  return { WAYNODE_LLM_KEY: key };
}
