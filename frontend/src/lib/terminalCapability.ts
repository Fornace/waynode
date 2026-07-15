export type TerminalCapabilityState = "checking" | "supported" | "unsupported" | "unavailable";
export type TerminalAffordance = "shown" | "hidden" | "disabled";

export function terminalCapabilityFromResponse(capabilities: unknown): TerminalCapabilityState {
  if (!capabilities || typeof capabilities !== "object" || !("terminal" in capabilities)) {
    return "unavailable";
  }
  const terminal = (capabilities as { terminal?: unknown }).terminal;
  if (terminal === true) return "supported";
  if (terminal === false) return "unsupported";
  return "unavailable";
}

export function terminalAffordance(state: TerminalCapabilityState): TerminalAffordance {
  if (state === "supported") return "shown";
  if (state === "unsupported") return "hidden";
  return "disabled";
}
