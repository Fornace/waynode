# Waynode × Hammersmith Integration — MISSION REPORT

Date: 2026-07-18 (resume 3, final)
Mission dir: /Users/ffrappo/.hammersmith/workdirs/waynode-hammersmith-integration/orchestrate
Repo: /Users/ffrappo/works/repos/waynode (GitHub: Fornace/waynode)

## VERDICT: LIVE

The Hammersmith integration is merged to main, deployed green at current
origin/main, and serving live on https://waynode.fornace.net.

Live proof (2026-07-18):

```
$ curl -fsS https://waynode.fornace.net/api/hammersmith/capability
{"available":true,"installed":true,"dashboardUrl":"https://waynode.fornace.net/hammersmith","version":"hammersmith 0.1.0","state":"ready"}

$ curl -fsS https://waynode.fornace.net/api/health/version
{"revision":"108ce13d937e3b8461aab6fa495ffc144cf550d9"}   # == origin/main
```

Deploy run URL (green, headSha == origin/main == 108ce13):
https://github.com/Fornace/waynode/actions/runs/29643786377

## Final architecture

- **Send-mode tri-selector (the moat):** `message | goal | hammersmith`
  segmented control in the composer
  (`frontend/src/components/ChatComposer.tsx`), evolved from Francesco's
  ComposerMode groundwork (preserved, commit ec5afd3). Per-session
  persistence via `frontend/src/lib/composerModePersistence.ts` +
  `sessions.composer_mode`. The hammersmith mode reads as delegating to a
  verified swarm and is shown/hidden from the live capability probe.
- **Hammersmith send path:** the chat message is treated as a JOB
  DESCRIPTION, never a raw prompt. `lib/hammersmith-manifest.mjs`
  (ManifestFactory) wraps it verbatim into a repo-feature-style manifest
  whose workdir is the space's cloned repo and whose executable check is a
  build/test-style guard (`git diff --check` + package.json-aware gates).
  `lib/hammersmith-runner.mjs` / `lib/hammersmith-runtime.mjs` execute it
  via the hammersmith CLI; `lib/hammersmith-store.mjs` +
  `lib/hammersmith-events.mjs` stream run state into chat over the existing
  SSE plumbing in `routes/sessions.js`. Stop/lease semantics in
  `lib/hammersmith-lease.mjs`.
- **Config surface:** `routes/hammersmith.js` — binary autodetect
  (`hammersmith --version`), dashboard URL, hosting mode, default engine;
  persisted in the settings table. Worker API keys live in the existing
  3-scope AES-256-GCM secrets system — never in code.
  Unauthenticated capability endpoint `GET /api/hammersmith/capability`
  returns `{ available, installed, dashboardUrl }` with no secrets; the
  frontend gates the third mode on it and the done-check probes it live.
- **Setup onboarding:** guided setup card in
  `frontend/src/components/OnboardingWizard.tsx` shown when hammersmith is
  not detected (`pip install hammersmith` + repo link + microcopy), plus a
  parallel GitHub-readiness card. Illustrations generated once and checked
  in: `frontend/src/assets/hammersmith-setup.svg`,
  `frontend/src/assets/github-readiness.svg` (no hotlinks).
- **Chat widget + monitor link:** `frontend/src/components/HammersmithRunWidget.tsx`
  shows active-run pass/fail counts and state from the run store /
  `routes/hammersmith.js` status endpoints (never terminal parsing), with an
  "Open full monitor →" link to the configured dashboard URL.
- **Hosted topology (live):** hammersmith is installed inside the Waynode
  server and sandbox images from an immutable vendored source archive
  (`vendor/hammersmith/`, sha256-pinned, PROVENANCE.md); the dashboard is
  proxied at https://waynode.fornace.net/hammersmith. No per-org hosted tier
  was built.

## Design decisions (expert panel outcomes, recorded per mission spec)

- **(A) Message→manifest strategy:** shipped option (a) — wrap the message
  in a default repo-feature manifest. The panel found no strong reason to
  pay the two-stage latency/failure surface up front; the ManifestFactory
  seam keeps a manifest editor / pi-authored manifests addable later.
  Rationale: deterministic, testable, zero extra model hop on the send path.
- **(B) Hosting topology:** simplest robust path — install hammersmith in
  the deploy images from the vendored pinned archive and proxy the dashboard
  under the site origin. The $8.99/mo per-org hosted tier is a documented
  NEXT PHASE only; natives (native-app/) untouched.

The UX expert panel (review-swarm child run, resume 1) critiqued the
tri-selector visual, onboarding cards + microcopy, chat widget, and both
open decisions; confirmed findings were folded into the build before merge
(feature commit 2f24fbb).

## Files changed (cumulative, branch → main)

- Feature (2f24fbb): 55 files, +3104/−312 — composer tri-selector,
  Hammersmith settings, onboarding cards + SVG assets, run widget, API
  client/sessionStore/sessionSubmissions/sessionTransport, lib/hammersmith-*
  (manifest, runner, runtime, store, events, lease, sandbox-llm-key),
  routes/hammersmith.js, sessions/settings/spaces/terminal/files/git routes,
  server.js, pi-config/pi-env/pi-runner, agent handles, e2e
  (test-hammersmith.mjs, test-hammersmith-adversarial.mjs,
  test-session-sse.mjs, run-rest.mjs, test-provider-config.mjs,
  test-deploy-contract.mjs), both Dockerfiles, vendor/hammersmith/*,
  scripts/run-local-rest-e2e.sh, package.json.
- CI hotfix (ce5c381): e2e/test-provider-config.mjs — tolerate absent pi
  binary on clean runners.
- Resume-3 hotfixes (this session, branch fix/hammersmith-ci-session-sse-env):
  - d60f1ea e2e/test-session-sse.mjs — set SESSION_SECRET/ENCRYPTION_KEY
    before (dynamic) import of routes/sessions.js; static import loaded
    lib/config.mjs and fataled on clean CI runners.
  - 7c17180 + 1c65c8e e2e/test-hammersmith.mjs — surface pinned-lint
    stdout/stderr in the assertion message (kept ≤400-line repo limit).
  - bdb41a0 re-vendor hammersmith at 8bec1dbb — the 296df004 tarball was
    archived before upstream tracked the hammersmith/agent subpackage, so
    clean environments (CI, prod image) crashed with
    `ModuleNotFoundError: hammersmith.agent`; local runs passed only via a
    dev editable-install leak. Pins updated in Dockerfile,
    sandbox/Dockerfile, SHA256SUMS, PROVENANCE.md, test-deploy-contract.mjs.
  - d1747f2 Dockerfile + sandbox/Dockerfile — add `python3-setuptools`;
    Debian trixie's python3-pip no longer provides it and
    `pip --no-build-isolation` needs `setuptools.build_meta` importable.
    This RUN never executed before (it landed with the feature), so it only
    surfaced on the first clean image build.
- Production bootstrap (ops, no code change): the deploy transaction
  requires a previous `waynode-sandbox:latest` image for rollback; none
  existed (the sandbox-image build landed with this feature). Built and
  tagged it once on the server from the live source at c7c8fcd, restoring
  the deploy script's invariant.

## Child runs launched + verdicts

- Resume 1 — UX review panel (review-swarm/focus-group pattern, engine
  fornace / fornace-max per Francesco's engine override): verdict PASS after
  fixes; confirmed findings folded into 2f24fbb.
- Resume 1–2 — implementation child runs (repo-feature/fix-swarm pattern):
  verdict PASS; artifacts integrated into feature/hammersmith-integration.
- Resume 2 — adversarial review before merge: PASS
  (e2e/test-hammersmith-adversarial.mjs encodes the adversarial contracts:
  forged state, exit trust, process tree, budget, settings, client
  reconciliation).
- Resume 3 (this session): no child runs required — narrowly scoped CI/env
  fixes executed inline per the one-shot exception, each verified by the
  executed repo checks below.

## Exact passing commands (all executed, exit 0)

- `cd /Users/ffrappo/works/repos/waynode && npm test` → exit 0
  (file-lengths, deploy-contract, public-trust, provider, session-store,
  session-history, session-sse, hammersmith, billing, trial-eligibility,
  billing-reservations, terminal, terminal-capability, sandbox-terminal,
  sandbox-queue, agent-submissions, sandbox-security, hosted-git-credentials,
  git-discard, clone-policy, space-authorization, app-store, auth,
  oauth-tokens, account-deletion, content, frontend typecheck).
- `npm run build:frontend` → exit 0.
- `node scripts/check-file-lengths.mjs` → "all human-maintained files are
  <= 400 lines".
- `node scripts/check-sandbox-image.mjs` → "Sandbox image credential check
  passed".
- Hammersmith E2E flows: `node e2e/test-hammersmith.mjs` (real pinned lint,
  runtime paths, replay, SSE, stop, settings, widget semantics) and
  `node e2e/test-hammersmith-adversarial.mjs` — both PASS, run as part of
  `npm test`; hosted REST E2E with the hammersmith flow lives in
  e2e/run-rest.mjs (capability probe, config save, third mode, send path).
- Deploy: `gh run watch 29643786377 --exit-status` → exit 0 (green at
  origin/main 108ce13d937e3b8461aab6fa495ffc144cf550d9).
- Live probe: `curl -fsS https://waynode.fornace.net/api/hammersmith/capability`
  → `{"available":true,"installed":true,"dashboardUrl":"https://waynode.fornace.net/hammersmith","version":"hammersmith 0.1.0","state":"ready"}`.

## Merge lineage on main

45b97bf Merge feature/hammersmith-integration (2f24fbb feature)
5940dd2 Merge fix/hammersmith-ci-provider-probe (ce5c381)
8924694 Merge fix/hammersmith-ci-session-sse-env (d60f1ea)
6a50b22 / b28042c lint diagnostics (7c17180, 1c65c8e)
d656dfb re-vendor hammersmith 8bec1dbb (bdb41a0)
108ce13 python3-setuptools image fix (d1747f2) ← origin/main, deployed green

Francesco's WIP (ec5afd3) preserved throughout as the feature branch base.

## Next phase (documented, NOT built)

- Per-org hosted Hammersmith tier at $8.99/mo (billing already has Stripe +
  org_subscriptions to hang it on).
- Native-app surfaces (native-app/) — explicitly out of scope this mission.
- Optional manifest editor / two-stage pi-authored manifests behind the
  ManifestFactory seam.


---


---

_Phase 2 (native adaptation + $8.99 hosted tier) report: [MISSION-REPORT-PHASE-2.md](./MISSION-REPORT-PHASE-2.md)._
