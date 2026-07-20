/** Accessibility contract — WCAG AA + repo docs/KEYBOARD-CONTRACT.md.
 *
 * Source-contract regression for the five confirmed a11y failures:
 *   1. OrgSettings integration inputs + invite-URL input have accessible names.
 *   2. SpaceSettings AGENTS.md editor textarea has an accessible name.
 *   3. AdminPanel per-user role <select> has an accessible name.
 *   4. SidebarMenus restores focus to its trigger button on close (no body drop).
 *   5. RepoPicker / OrgSettings / SpaceSettings tablists implement the APG
 *      roving-tabIndex keyboard model (ArrowLeft/Right/Home/End) with
 *      aria-controls <-> role="tabpanel" wiring, matching GitSidebar.tsx.
 *
 * Style mirrors e2e/test-public-trust.mjs: read sources, assert substrings.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const org = read("frontend/src/components/OrgSettings.tsx");
const space = read("frontend/src/components/SpaceSettings.tsx");
const admin = read("frontend/src/components/AdminPanel.tsx");
const sidebar = read("frontend/src/components/SidebarMenus.tsx");
const repo = read("frontend/src/components/RepoPicker.tsx");

// 1. OrgSettings: the four previously-unnamed inputs now expose aria-labels.
assert.ok(org.includes('aria-label="Obsidian'), "OrgSettings obsidian_url input needs an accessible name");
assert.ok(org.includes('aria-label="Honcho server'), "OrgSettings honcho_url input needs an accessible name");
assert.ok(org.includes('aria-label="Honcho workspace'), "OrgSettings honcho_workspace input needs an accessible name");
assert.ok(org.includes('aria-label="Organization invite link"'), "OrgSettings invite URL input needs an accessible name");

// 2. SpaceSettings: the AGENTS.md editor textarea has an accessible name.
assert.ok(space.includes('aria-label="AGENTS.md editor"'), "SpaceSettings AGENTS.md textarea needs an accessible name");

// 3. AdminPanel: the per-user role select names its user (OrgSettings pattern).
assert.ok(admin.includes("aria-label={`Role for ${u.name}`}"), "AdminPanel per-user role select needs aria-label");

// 4. SidebarMenus: a trigger ref is kept and focus is restored to it on close.
assert.match(sidebar, /\btriggerRef\b/, "SidebarMenus must keep a trigger ref");
assert.match(sidebar, /triggerRef\.current\?\.focus\(\)/, "SidebarMenus must restore focus to the trigger on close");

// 5. APG tablist model on all three role=tablist widgets.
for (const [name, src] of [["RepoPicker", repo], ["OrgSettings", org], ["SpaceSettings", space]]) {
  // Roving tabindex: only the active tab sits in the tab order.
  assert.match(src, /tabIndex=\{[^}]*\? 0 : -1[^}]*\}/, `${name}: roving tabIndex (active=0, others=-1) required`);
  // APG arrow / home / end keyboard navigation on the tab buttons.
  assert.ok(src.includes("ArrowRight"), `${name}: ArrowRight handling required`);
  assert.ok(src.includes("ArrowLeft"), `${name}: ArrowLeft handling required`);
  assert.ok(src.includes("Home"), `${name}: Home handling required`);
  assert.ok(src.includes("End"), `${name}: End handling required`);
  // Tab controls a panel; panel is labelled by the active tab.
  assert.match(src, /role="tabpanel"/, `${name}: role=tabpanel required`);
  assert.match(src, /aria-controls=/, `${name}: aria-controls wiring required`);
  assert.match(src, /aria-labelledby=/, `${name}: aria-labelledby wiring required`);
}

// Maintainability: each touched file stays within the 400-line repo limit.
for (const path of [
  "frontend/src/components/OrgSettings.tsx",
  "frontend/src/components/SpaceSettings.tsx",
  "frontend/src/components/AdminPanel.tsx",
  "frontend/src/components/SidebarMenus.tsx",
  "frontend/src/components/RepoPicker.tsx",
  "e2e/test-a11y-contract.mjs",
]) {
  const lines = read(path).split("\n").length;
  assert.ok(lines <= 400, `${path} has ${lines} lines (limit 400)`);
}

console.log("a11y contract: accessible names, focus restore, and APG tablists passed");
