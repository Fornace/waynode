import { config } from "./config.mjs";

/** Public, non-secret deployment capabilities advertised to every client. */
export function deploymentCapabilities(deployment = config.deployment) {
  return {
    terminal: deployment === "self-hosted",
  };
}
