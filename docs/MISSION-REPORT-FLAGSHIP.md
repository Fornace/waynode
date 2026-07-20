# Waynode Flagship Release — Mission Report

Date: 2026-07-20
Mission: waynode-flagship-release (fornace-max)

## VERDICT: LIVE

The flagship release is merged to main, deployed green, and serving live on
https://waynode.fornace.net. Three lanes shipped: QA hardening, product
polish, and marketing rebuild.

## Live proof (2026-07-20)

```
$ curl https://waynode.fornace.net/api/health/version
{"revision":"ee2eb199946fc62ad9f7d2dde719b15832704f50"}

$ curl https://waynode.fornace.net/api/hammersmith/capability
{"available":true,"installed":true,...,"state":"ready"}

$ curl https://waynode.fornace.net/ | shasum -a 256
0826516d6f255885  (baseline was 28b8ab28a2a9cab4 — landing changed)
```

Deploy green at current SHA:
https://github.com/Fornace/waynode/actions/runs/29746909255

## Lane 1 — QA hardening

4 tasks, all PASS (fornace-max). Real bugs found and fixed with
failing-first regression tests:
- **Stream store + transport**: SSE reconnect robustness, stale state
  recovery (frontend/src/lib/sessionStore.ts, sessionTransport.ts)
- **Session lifecycle**: race condition fixes in agent-manager.mjs,
  sessions.mjs, routes/sessions.js
- **Billing edges**: dunning + reservation edge cases
  (lib/billing-state.mjs, billing-stripe-operations.mjs)
- **Composer**: mobile viewport + mode persistence + sessionDrafts module
  (ChatTab.tsx, ChatMessage.tsx, frontend/src/lib/sessionDrafts.ts)

New regression suites (7 files, wired into package.json test chain):
- e2e/test-session-lifecycle.mjs
- e2e/test-session-stream-reconnect.mjs
- e2e/test-billing-edges.mjs
- e2e/test-composer-behaviors.mjs

## Lane 2 — Product polish

3 tasks, all PASS. Extends the macOS-native sidebar design language:
- **Design language**: sidebar-mac.css translucency + flat selection
  extended to settings, repo-picker, session-workbench, chat, workspace
  controls (12 CSS files updated)
- **Onboarding**: empty/loading/error states wired throughout
  (OnboardingWizard.tsx, OrgSettings.tsx, SpaceSettings.tsx)
- **Accessibility**: aria-labels, tablist roles, focus management
  (App.tsx, Sidebar.tsx, OrgSettings.tsx)

New contract test suites (3 files):
- e2e/test-design-language.mjs
- e2e/test-onboarding-states.mjs
- e2e/test-a11y-contract.mjs

## Lane 3 — Marketing rebuild

1 task, PASS. Original landing with explanatory mockups:
- **LandingPage.tsx** rewritten (334 lines): distinctive layout with
  product cards (Hosted vs Self-hosted), CSS/SVG explanatory frames
  (tri-selector, verified-swarm run, native handoff)
- **launch.css** reworked for original visual language
- **Deleted 6 legacy screenshot PNGs** — doctrine: mockups explain, not
  imitate (meaning > fidelity, no fake screenshots)
- **docs/PRICING.md + CRAFT_DIRECTION.md** updated with honest copy
  (self-hosted free/open-source, hosted $8.99/mo)

## Lane 4 — Native edge-case hardening

1 task, PASS. Swift 6 edge cases fixed:
- APIClient, ChatReducer, SSEClient, SessionStore+Submission, WSClient
- New NativeEdgeCaseTests.swift regression suite (254 lines)
- swift test: 88 tests in 12 suites (was 81)

## Process notes

- Engine: fornace (config key) / model fornace-max throughout
- Root cause of initial fix-lane failures: manifests used bare `fornace`
  as the engine key (correct) but the error was a transient API quota
  exhaustion on the fornace/Kimi gateway — resolved on retry
- Orchestration pattern: repo-feature implementation → review-swarm audits
  (6 QA + 4 polish scouts) → fix-swarm lanes → adversarial review
- Integration: 4 worktrees merged serially; 2 files force-added past
  .gitignore (sessionDrafts.ts, test-composer-behaviors.mjs)
- File-length gate: ChatReducer.swift and App.tsx trimmed to ≤399 lines

## Final test gate

```
npm test: exit 0 (33 test scripts including 7 new suites)
swift test: 88 tests in 12 suites passed
check-file-lengths: passed
git diff --check: clean
```

## Merge lineage on main

```
ee2eb19 feat(flagship): QA hardening + polish + native edge cases + marketing rebuild
218a902 (amended — added force-tracked sessionDrafts.ts + test-composer-behaviors.mjs)
8b7479d Merge feature/flagship-marketing: flagship landing rebuild
7c7dc66 Merge feature/sidebar-mac (pre-mission base)
```
