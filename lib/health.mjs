import { accessSync, constants } from "node:fs";
import db from "./db.mjs";
import { billingEnabled, config } from "./config.mjs";

function accessible(path, mode = constants.R_OK) {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Cheap, side-effect-free readiness checks suitable for Docker and monitors. */
export function readinessReport() {
  const checks = {
    database: false,
    data: accessible(config.dataDir, constants.R_OK | constants.W_OK),
    repositories: accessible(config.reposDir, constants.R_OK | constants.W_OK),
  };

  try {
    checks.database = db.prepare("SELECT 1 AS ok").get()?.ok === 1;
  } catch {
    checks.database = false;
  }

  if (config.deployment === "hosted") {
    checks.kvm = accessible("/dev/kvm", constants.R_OK | constants.W_OK);
    checks.sandboxCredential = Boolean(config.llm.sandboxRuntimeKey);
    checks.oauth = Boolean(
      (config.github.clientId && config.github.clientSecret)
      || (config.gitlab.clientId && config.gitlab.clientSecret),
    );
    checks.billing = billingEnabled;
  }

  return {
    ready: Object.values(checks).every(Boolean),
    revision: config.revision,
    deployment: config.deployment,
    checks,
  };
}

export function versionReport() {
  return { revision: config.revision };
}

/** Public status surface: preserve the readiness signal without topology detail. */
export function publicReadinessReport(report = readinessReport()) {
  return { ready: report.ready === true };
}
