import { config } from "./config.mjs";
import { resolvePiModel } from "./pi-model.mjs";

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
