/** Onboarding and state-surface regression contract (failing-first). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const app = read("frontend/src/App.tsx");
const orgSettings = read("frontend/src/components/OrgSettings.tsx");
const wizard = read("frontend/src/components/OnboardingWizard.tsx");

// --- Bug 1: onboarding clone must stream progress into the session chat ---
// The sidebar path (Sidebar.tsx handleClone) opens api.spaces.cloneStream and
// injects progress via store.injectProgress, surfacing "✗ Clone failed" on
// error.  The onboarding path must match that behaviour exactly.
assert.ok(app.includes("cloneStream"), "Bug 1: onboarding handler must open the clone stream (api.spaces.cloneStream)");
assert.ok(
  /handleOnboardingClone[\s\S]{0,1500}cloneStream/.test(app),
  "Bug 1: cloneStream must be referenced inside handleOnboardingClone",
);
assert.ok(
  /handleOnboardingClone[\s\S]*injectProgress[\s\S]*Clone failed/.test(app),
  "Bug 1: onboarding clone must inject progress and the ✗ Clone failed surface into the session",
);

// --- Bug 6: spacesLoading must initialise true so the wizard does not flash ---
// App.tsx initialised spacesLoading to false, so one committed render shows the
// zero-spaces wizard before the passive loadSpaces effect flips it true.
assert.ok(
  /\[spacesLoading,\s*setSpacesLoading\]\s*=\s*useState\(\s*true\s*\)/.test(app),
  "Bug 6: spacesLoading must initialise to true to avoid flashing the zero-spaces wizard",
);

// --- Bug 2: OrgSettings initial load must have loading + error + retry ---
// The Promise.all for settings+members+models had no .catch and no loading flag;
// the Members tab rendered "No members yet." during load and permanently after
// a failed fetch.
assert.ok(
  orgSettings.includes("[loading, setLoading]"),
  "Bug 2: OrgSettings must track a dedicated loading flag",
);
{
  const loadChain = orgSettings.split("Promise.all")[1] ?? "";
  const chainHead = loadChain.split("\n  },")[0];
  assert.ok(/\.catch\(/.test(chainHead), "Bug 2: OrgSettings Promise.all load must have a .catch handler");
}
assert.ok(
  /loadOrgData/.test(orgSettings),
  "Bug 2: OrgSettings must expose a loadOrgData callback so retry can re-run the load",
);
assert.ok(
  /loadError[\s\S]*Try again|onClick=\{loadOrgData\}/.test(orgSettings),
  "Bug 2: OrgSettings load error must render a retry action that re-runs the load",
);
{
  const membersSection = orgSettings.split('tab === "members" && (')[1] ?? "";
  assert.ok(
    /\bloading\b/.test(membersSection),
    "Bug 2: members empty state must be gated on loading (not shown during load or after failure)",
  );
}

// --- Bug 3: billing error card must have a retry action ---
// The billing error card rendered with no action; extract the fetch into a
// callback and add a 'Try again' button.
{
  const afterBillingError = orgSettings.split("Billing unavailable")[1] ?? "";
  assert.ok(
    /Try again|onClick=\{loadBilling\}/.test(afterBillingError),
    "Bug 3: billing error card must have a 'Try again' retry action wired to loadBilling",
  );
}

// --- Bug 4: org rename must check res.ok ---
// saveName had no res.ok check, no catch; response JSON was applied unchecked.
assert.ok(
  /saveName[\s\S]{0,800}res\.ok/.test(orgSettings),
  "Bug 4: saveName must check res.ok before applying the rename",
);

// --- Bug 5: completed onboarding guides must collapse into a quiet ready line ---
// When hammersmithState==='ready' AND githubConnected, both guide cards stayed
// fully rendered.  They should collapse into a single quiet "Environment ready"
// line, staying expanded whenever either check is incomplete.
assert.ok(
  /environmentReady|Environment ready|onboarding-env-ready/.test(wizard),
  "Bug 5: wizard must collapse completed setup guides into a quiet 'Environment ready' line",
);

// --- Guard: no owned file exceeds the 400-line maintainability limit ---
for (const path of [
  "frontend/src/App.tsx",
  "frontend/src/components/OrgSettings.tsx",
  "frontend/src/components/OnboardingWizard.tsx",
]) {
  const raw = read(path);
  const lines = raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0);
  assert.ok(lines <= 400, `${path} exceeds 400 lines (${lines})`);
}

console.log("onboarding states: clone stream, loading/error/retry, billing retry, res.ok, ready collapse, spacesLoading init — all passed");
