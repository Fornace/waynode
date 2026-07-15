/** Deployment capability, web-state, and direct terminal denial regression. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-terminal-capability-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "terminal-capability-test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WAYNODE_DEPLOYMENT = "hosted";

try {
  const { deploymentCapabilities } = await import("../lib/capabilities.mjs");
  const { enforceTerminalAvailability } = await import("../lib/pi-runner.mjs");
  const { getTerminal } = await import("../lib/agent-manager.mjs");
  const {
    terminalAffordance,
    terminalCapabilityFromResponse,
  } = await import("../frontend/src/lib/terminalCapability.ts");

  assert.equal(deploymentCapabilities("hosted").terminal, false, "hosted advertises no terminal");
  assert.equal(deploymentCapabilities("self-hosted").terminal, true, "self-host advertises terminal");
  assert.equal(deploymentCapabilities("typo").terminal, false, "unknown deployment fails closed");

  assert.equal(terminalAffordance(terminalCapabilityFromResponse({ terminal: false })), "hidden", "hosted terminal control is hidden");
  assert.equal(terminalAffordance(terminalCapabilityFromResponse({ terminal: true })), "shown", "self-host terminal control is shown");
  assert.equal(terminalCapabilityFromResponse(undefined), "unavailable", "fetch/missing field is unavailable, not unsupported");
  assert.equal(terminalAffordance("unavailable"), "disabled", "unknown capability cannot open a terminal");
  assert.equal(terminalAffordance("checking"), "disabled", "checking capability cannot race open");

  assert.throws(() => enforceTerminalAvailability("hosted"), (error) => error.terminalDisabled === true);
  assert.throws(() => enforceTerminalAvailability("unknown"), (error) => error.terminalDisabled === true);
  assert.doesNotThrow(() => enforceTerminalAvailability("self-hosted"));

  let spawned = false;
  await assert.rejects(
    getTerminal({ id: "direct-route", space_id: "space" }, async () => {
      spawned = true;
      throw new Error("must not spawn");
    }),
    (error) => error.terminalDisabled === true,
    "direct hosted acquisition remains denied",
  );
  assert.equal(spawned, false, "hosted denial happens before PTY acquisition");
  console.log("terminal capability regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
