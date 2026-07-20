/** Authenticated design-language regression contract.
 *
 *  Locks the macOS-native sidebar language (canonical sidebar-mac.css, which
 *  is imported LAST in index.css and wins by source order) across every
 *  authenticated surface: flat 6px rounded-rect selections at the canonical
 *  rgba(74, 124, 229, 0.28) fill, quiet plain-case 11px/600 labels with no
 *  letter-spacing, plain-text counts (no pill chrome), hairline separators,
 *  one accent blue (no third blue, no indigo), no decorative gradients or
 *  glow/lift/gloss, and WCAG-AA faint text contrast on the dark surfaces.
 *
 *  This is a SOURCE CONTRACT (like test-public-trust.mjs): it reads the CSS
 *  sources directly and asserts on parsed selector blocks (not just file-wide
 *  strings) so regressions pin to the offending rule.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

const sidebarMac = read("frontend/src/styles/sidebar-mac.css");
const repoPicker = read("frontend/src/styles/repo-picker.css");
const settings = read("frontend/src/styles/settings.css");
const sessionWorkbench = read("frontend/src/styles/session-workbench.css");
const chatComposer = read("frontend/src/styles/chat-composer.css");
const authenticatedStates = read("frontend/src/styles/authenticated-states.css");
const workspaceControls = read("frontend/src/styles/workspace-controls.css");
const chatMessages = read("frontend/src/styles/chat-messages.css");
const baseShell = read("frontend/src/styles/base-shell.css");
const sidebarDialogs = read("frontend/src/styles/sidebar-dialogs.css");
const gitSidebarLayout = read("frontend/src/components/GitSidebarLayout.css");
const gitSidebarActions = read("frontend/src/components/GitSidebarActions.css");

/** Pull the first `<selector> { ... }` body. Returns null if absent. */
function ruleBody(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc + "\\s*\\{([^}]*)\\}", "m");
  const m = css.match(re);
  return m ? m[1] : null;
}
function hasRule(css, selector) {
  return ruleBody(css, selector) !== null;
}

/* 1 — Canonical selection fill lives wherever selections live. */
assert.match(sidebarMac, /rgba\(74, 124, 229, 0\.28\)/, "sidebar-mac: canonical selection fill absent");
{
  const tab = ruleBody(workspaceControls, ".tab-btn.active");
  assert.ok(tab, ".tab-btn.active rule missing");
  assert.match(tab, /rgba\(74, 124, 229, 0\.28\)/, ".tab-btn.active must use canonical fill");
  assert.match(tab, /box-shadow:\s*none/i, ".tab-btn.active must drop the raised chrome");
}
{
  const seg = ruleBody(chatComposer, ".composer-segment.selected");
  assert.ok(seg, ".composer-segment.selected rule missing");
  assert.match(seg, /rgba\(74, 124, 229, 0\.28\)/, ".composer-segment.selected must use canonical fill");
  assert.match(seg, /box-shadow:\s*none/i, ".composer-segment.selected must drop the inset ring");
  assert.match(seg, /color:\s*var\(--text\)/i, ".composer-segment.selected must reset to --text");
}
{
  const row = ruleBody(gitSidebarLayout, ".git-file-row.active");
  assert.ok(row, ".git-file-row.active rule missing");
  assert.match(row, /rgba\(74, 124, 229, 0\.28\)/, ".git-file-row.active must use canonical fill");
  assert.doesNotMatch(row, /box-shadow:\s*inset/i, ".git-file-row.active must drop the accent spine");
}

/* 2 — Tree-connector ::after tick killed in canonical sidebar-mac.css. */
assert.match(
  sidebarMac,
  /\.session-item\.active::after\s*\{\s*display:\s*none/,
  "sidebar-mac must kill .session-item.active::after tick",
);

/* 3 — Repo picker count is plain text (no pill chrome). */
{
  const body = ruleBody(repoPicker, ".repo-group-count");
  assert.ok(body, ".repo-group-count rule missing");
  assert.doesNotMatch(body, /border-radius:\s*999px/i, ".repo-group-count must not be a 999px pill");
  assert.doesNotMatch(body, /background:/i, ".repo-group-count must drop background tint");
  assert.doesNotMatch(body, /padding:/i, ".repo-group-count must drop pill padding");
  assert.match(body, /font-size:\s*11px/i, ".repo-group-count must read as a plain count");
}

/* 4 — Settings section title is a quiet plain-case label. */
{
  const body = ruleBody(settings, ".settings-section-title");
  assert.ok(body, ".settings-section-title rule missing");
  assert.doesNotMatch(body, /text-transform:\s*uppercase/i, ".settings-section-title must not shout");
  assert.doesNotMatch(body, /letter-spacing:\s*0\.08em/i, ".settings-section-title must drop tracking");
  assert.match(body, /text-transform:\s*none/i, ".settings-section-title must be plain case");
  assert.match(body, /font-size:\s*11px/i, ".settings-section-title must be 11px/600");
}

/* 5 — Review button count + error marker lose pill/dot chrome. */
{
  const b = ruleBody(sessionWorkbench, ".review-button b");
  assert.ok(b, ".review-button b rule missing");
  assert.doesNotMatch(b, /border-radius:\s*999px/i, ".review-button b must not be a pill");
  assert.match(b, /font-size:\s*11px/i, ".review-button b must read as plain 11px text");
  const i = ruleBody(sessionWorkbench, ".review-button i");
  assert.ok(i, ".review-button i rule missing");
  assert.doesNotMatch(i, /border-radius:\s*999px|border-radius:\s*50%/i, ".review-button i must not be a dot");
  assert.doesNotMatch(i, /background:\s*var\(--red\)/i, ".review-button i must drop the red dot fill");
}

/* 6 — Repo picker row uses the quiet row hover, not a border-left accent. */
{
  const hover = ruleBody(repoPicker, ".repo-item:hover");
  assert.ok(hover, ".repo-item:hover rule missing");
  assert.doesNotMatch(hover, /border-left-color:\s*var\(--accent\)/i, ".repo-item:hover must drop border-left accent");
}

/* 7 — Git panel labels are plain case (no uppercase, no tracking). */
for (const [file, sel] of [
  [gitSidebarLayout, ".git-changes-count"],
  [gitSidebarActions, ".git-branches-label"],
  [gitSidebarActions, ".git-branch-section h4"],
  [gitSidebarActions, ".git-remote-tag"],
]) {
  const body = ruleBody(file, sel);
  assert.ok(body, `${sel} rule missing`);
  assert.doesNotMatch(body, /text-transform:\s*uppercase/i, `${sel} must not shout`);
}

/* 8 — Repo picker modal is translucent (frosted), not opaque. */
{
  const body = ruleBody(authenticatedStates, ".repo-picker-modal");
  assert.ok(body, ".repo-picker-modal override missing");
  assert.match(body, /backdrop-filter:\s*blur/i, ".repo-picker-modal must restore blur");
  assert.doesNotMatch(body, /backdrop-filter:\s*none/i, ".repo-picker-modal must not disable blur");
  assert.match(body, /rgba\(/i, ".repo-picker-modal must be translucent (rgba)");
}

/* 9 — Onboarding surface is flat (no gradient, no uppercase kickers/status). */
{
  const onboard = ruleBody(workspaceControls, ".onboarding");
  assert.ok(onboard, ".onboarding rule missing");
  assert.doesNotMatch(onboard, /radial-gradient/i, ".onboarding must drop the decorative gradient");
  const kicker = ruleBody(workspaceControls, ".onboarding-kicker");
  assert.ok(kicker, ".onboarding-kicker rule missing");
  assert.doesNotMatch(kicker, /text-transform:\s*uppercase/i, ".onboarding-kicker must be plain case");
  const status = ruleBody(workspaceControls, ".onboarding-guide-status");
  assert.ok(status, ".onboarding-guide-status rule missing");
  assert.doesNotMatch(status, /border-radius:\s*999px/i, ".onboarding-guide-status must drop the pill");
  assert.doesNotMatch(status, /text-transform:\s*uppercase/i, ".onboarding-guide-status must be plain case");
}

/* 10 — Hammersmith run card is matte (no gradient); kicker is plain case. */
{
  const card = ruleBody(chatMessages, ".hammersmith-run");
  assert.ok(card, ".hammersmith-run rule missing");
  assert.doesNotMatch(card, /linear-gradient/i, ".hammersmith-run must drop the gradient");
  const kicker = ruleBody(chatMessages, ".hammersmith-run-kicker");
  assert.ok(kicker, ".hammersmith-run-kicker rule missing");
  assert.doesNotMatch(kicker, /text-transform:\s*uppercase/i, ".hammersmith-run-kicker must be plain case");
}

/* 11 — Message tags are plain 11px faint text, not 9px uppercase pills. */
{
  const body = ruleBody(chatMessages, ".msg-tag");
  assert.ok(body, ".msg-tag rule missing");
  assert.doesNotMatch(body, /border-radius:\s*999px/i, ".msg-tag must drop the pill radius");
  assert.doesNotMatch(body, /text-transform:\s*uppercase/i, ".msg-tag must not shout");
  assert.match(body, /font-size:\s*11px/i, ".msg-tag must read as plain 11px text");
}

/* 12 — One accent blue: no one-off indigo. */
{
  const selection = ruleBody(baseShell, "::selection");
  assert.ok(selection, "::selection rule missing");
  assert.doesNotMatch(selection, /99,\s*102,\s*241/, "::selection must not use indigo");
  const tabUnderline = ruleBody(baseShell, ".workspace-tabs button.active::after");
  assert.ok(tabUnderline, "tab underline rule missing");
  assert.doesNotMatch(tabUnderline, /#91b3ff/i, "tab underline must not use one-off #91b3ff");
  const hint = ruleBody(settings, ".settings-hint");
  assert.ok(hint, ".settings-hint rule missing");
  assert.doesNotMatch(hint, /99,\s*102,\s*241/, ".settings-hint must not use indigo");
  const modalFocus = ruleBody(sidebarDialogs, ".modal-input:focus");
  assert.ok(modalFocus, ".modal-input:focus rule missing");
  assert.doesNotMatch(modalFocus, /99,\s*102,\s*241/, ".modal-input:focus must not use indigo ring");
  const formFocus = ruleBody(repoPicker, ".form-input:focus");
  assert.ok(formFocus, ".form-input:focus rule missing");
  assert.doesNotMatch(formFocus, /99,\s*102,\s*241/, ".form-input:focus must not use indigo ring");
}

/* 13 — No hover lifts; no gloss shadows on primary buttons. */
{
  const connectHover = ruleBody(repoPicker, ".connect-btn:hover");
  assert.ok(connectHover, ".connect-btn:hover rule missing");
  assert.doesNotMatch(connectHover, /translateY/i, ".connect-btn:hover must not lift");
  const connect = ruleBody(repoPicker, ".connect-btn");
  assert.ok(connect, ".connect-btn rule missing");
  assert.doesNotMatch(
    connect,
    /inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.15\)/i,
    ".connect-btn must drop the white-gloss inset",
  );
  const onboardingHover = ruleBody(workspaceControls, ".onboarding-primary:hover:not(:disabled)");
  assert.ok(onboardingHover, ".onboarding-primary:hover rule missing");
  assert.doesNotMatch(onboardingHover, /translateY/i, ".onboarding-primary:hover must not lift");
  const btnPrimary = ruleBody(sidebarDialogs, ".btn-primary");
  assert.ok(btnPrimary, ".btn-primary rule missing");
  assert.doesNotMatch(
    btnPrimary,
    /inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.15\)/i,
    ".btn-primary must drop the white-gloss inset",
  );
}

/* 14 — Contrast AA: faint text raised to ~#98a2b3 / rgba(255,255,255,.55). */
assert.match(baseShell, /--text-faint:\s*#98a2b3/, "base-shell --text-faint must meet AA on #0a0a0b");
assert.match(
  sessionWorkbench,
  /--text-faint:\s*rgba\(255,\s*255,\s*255,\s*\.55\)/,
  "session-workbench --text-faint must meet AA on #0c0c0d",
);

console.log("design language: canonical selections, plain labels, AA contrast passed");
