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

# Waynode × Hammersmith — DEFERRED PHASES (native + hosted tier) — MISSION REPORT

Date: 2026-07-18
Mission dir: /Users/ffrappo/.hammersmith/workdirs/waynode-hammersmith-deferred/orchestrate
Repo: /Users/ffrappo/works/repos/waynode (GitHub: Fornace/waynode)

## VERDICT: LIVE

Both deferred phases are merged to main, deployed green at current
origin/main, and serving live on https://waynode.fornace.net — the phase-1
web integration is untouched and still serving (see live probes below).

Live proof (2026-07-18, post-merge):

```
$ curl -fsS https://waynode.fornace.net/api/health/version
{"revision":"6f0dff792315d07657a7edaf751ae42cad0e4a55"}   # == origin/main

$ curl -fsS https://waynode.fornace.net/api/hammersmith/capability
{"available":true,"installed":true,"dashboardUrl":"https://waynode.fornace.net/hammersmith","version":"hammersmith 0.1.0","state":"ready"}
```

Deploy runs (both green, headSha == origin/main at merge time):
- Hosted tier merge a2c54f0: https://github.com/Fornace/waynode/actions/runs/29652795313
- Native merge 6f0dff7 (final SHA): https://github.com/Fornace/waynode/actions/runs/29653004412

Done-gate: `bash /Users/ffrappo/.hammersmith/missions/waynode-hammersmith-deferred/check.sh`
→ exit 0 ("CHECK PASS: deferred phases (native + hosted tier) shipped,
deployed green, and live"), executed after the final deploy.

## Deliverable A — native adaptation (iOS 17+/macOS 14+, SwiftUI, Swift 6)

No new server endpoints were needed: the app consumes the existing
capability probe, the hammersmith send route, the jobs list/stop routes, and
the session SSE stream (`hammersmith_run` events), exactly per PLAN.md §1
(server-resident execution).

- **Tri-selector:** `message | goal | hammersmith` in the native composer
  (`native-app/App/Views/ComposerBar.swift`) — a private `ComposerMode`
  enum replacing the goal bool; the hammersmith toggle (a11y id
  `composer.hammersmith`, "checkmark.seal") renders only when the live
  capability probe reports `available == true`; mutually exclusive with
  goal mode; hint strip "Hammersmith · delegates this job to a verified
  swarm"; placeholder "Describe the job…".
- **Send path:** `SessionStore+Hammersmith.swift` sends the prompt as a JOB
  DESCRIPTION via `POST /api/sessions/:id/hammersmith`
  (`APIClient+Hammersmith.swift`, body `{mode:"hammersmith", prompt,
  submissionId}`) — the same server-side manifest+runner path the web uses.
  Draft discipline mirrors sendMessage (failed-draft reuse, retry routing
  in `retryFailedSubmission` for kind `.hammersmith`).
- **Run-status surface:** run state streams over the existing SSE as
  `hammersmith_run` events, decoded in `Chat.swift`
  (`SSEEvent.Kind.hammersmithRun`) and folded by
  `ChatReducer+Hammersmith.swift` (`upsertHammersmithRun` — in-place by run
  id). Rendered inline in the transcript by `HammersmithRunView`
  (lifecycle title, checked/total, passed, failed counts, thin
  ProgressView, error line, Stop while running, and an "Open monitor →"
  link that accepts only http/https monitor URLs with no userinfo) — state
  from the run store / status endpoints only, never terminal parsing.
  Cold rehydrate: `refreshHammersmithJobs()` from
  `GET /api/sessions/:id/hammersmith/jobs` on stream open.
- **Degraded behavior:** capability probe failure or `available != true` →
  the third mode is hidden; send errors (402/503) surface in the composer
  error banner with the draft preserved.
- **Transport design:** the four hammersmith members are requirements on a
  `HammersmithTransport: SessionTransport` sub-protocol (protocol-extension
  members alone would statically resolve to the 501 defaults through the
  `any SessionTransport` existential); APIClient conforms; existing test
  doubles unaffected. `ChatReducer.swift` line-cap maneuver: setters
  relaxed to `public internal(set)` and `HistoryItem`+`loadHistory` moved
  verbatim to `ChatReducer+History.swift`.
- **Known follow-up (documented, non-blocking):** the checked-in
  `project.pbxproj` uses an explicit file list (verified: no
  PBXFileSystemSynchronizedRootGroup), so new App/Views files do not
  compile until the next `xcodegen` regeneration. The compiled
  HammersmithRunView + UserBubbleShape therefore live in WaynodeCore
  (SwiftPM globs Sources/); `App/Views/HammersmithRunView.swift` is the
  app-layer twin that shadows the Core version with zero call-site changes
  after regeneration.

GATE A evidence (main repo, merge commit 6f0dff7):

```
$ cd native-app/WaynodeCore && swift test
... Test run with 81 tests in 11 suites passed ...   # 70 pre-existing + 11 new
$ xcodebuild -project native-app/Waynode.xcodeproj -scheme WaynodeMac \
    -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
** BUILD SUCCEEDED **
$ xcodebuild -project native-app/Waynode.xcodeproj -scheme Waynode \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
** BUILD SUCCEEDED **
```

New tests (`WaynodeCore/Tests/WaynodeCoreTests/HammersmithChatTests.swift`,
11): capability decode (full/lenient), SSE wire decode (job key, missing
job → .unknown), reducer append/upsert-in-place/active-run, store send
success, 402 failure → failedDraft kind .hammersmith → retry routes back,
cold rehydrate from the jobs endpoint, capability gating nil on throw.

## Deliverable B — per-org hosted Hammersmith tier ($8.99/mo)

- **Entitlement:** `PLANS.hammersmith` ($8.99/mo, 5M tokens, 2GiB, 1 seat)
  in `lib/billing-state.mjs` + `hostedHammersmithEntitled(orgId)` (plan
  `hammersmith` AND status active|trialing). The tier is a standalone org
  subscription hanging on the existing Stripe + org_subscriptions
  machinery. `STRIPE_PRICE_HAMMERSMITH` lives in
  `config.stripe.hammersmithPriceId`, deliberately OUT of `priceIds` (the
  `billingEnabled` every(Boolean) trap); `priceIdForPlan()` stitches it
  back into checkout and `configuredEntitlement` matches it in webhooks.
- **Send-path gates (routes/hammersmith.js):** admission
  (`hostedHammersmithAdmission`, 402 paywall naming the tier and price)
  runs BEFORE the credential check (503) and BEFORE the atomic quota
  reservation — non-entitled orgs see the subscribe message, not a
  credential error. Org-less sessions skip the gate exactly like the
  existing chat-turn reservation policy (`reserveHammersmithBudget`/
  `canUseHostedWorkspace` parity — documented limitation below).
- **Credential-model hardening:** hosted runs still require the org/space
  `HAMMERSMITH_LLM_KEY` resolved ONLY via the 3-scope AES-256-GCM secrets
  system (`lib/sandbox-llm-key.mjs`); never logged, never in code, never
  returned by any endpoint — the capability endpoint reports entitlement
  only, never credential presence. Quota reservations settle on ALL
  terminal run paths via `settleHammersmithReservation` (finished →
  finish, stopped → release, idempotent, DB-verified in tests).
- **Caller-scoped capability:** `GET /api/hammersmith/capability` gained an
  `optionalAuth` middleware (new in `lib/auth.mjs`; `requireAuth`
  observable behavior byte-identical). Authenticated callers additionally
  get `hosted: { billingRequired, entitled }` (any-org rollup); the
  unauthenticated payload is byte-identical to phase 1.
- **Dunning:** `PLANS_WITH_ENTITLEMENT` now includes `hammersmith`, so
  `invoice.payment_failed` flips the tier to past_due and revokes the
  entitlement (found by adversarial review, fixed pre-merge).

GATE B evidence (main repo, branch feature/hosted-hammersmith-tier → main):

```
$ node e2e/test-billing-hammersmith.mjs
test-billing-hammersmith: PASS            # 314 lines (≤400 gate)
$ npm test                                 # full chain incl. the new suite
... exit 0 (file-lengths, deploy-contract, all 24 e2e suites, frontend tsc)
```

`e2e/test-billing-hammersmith.mjs` (new, 314 lines) covers: plan shape,
billingEnabled trap guard, webhook entitlement create/switch/delete,
dunning → past_due → not entitled → recovery, admission-gate matrix, gate
order (402 before 503), real-HTTP capability endpoint (anonymous vs Bearer
api_tokens; no secret/llm fields), credential boundary (space-over-org
precedence, 503, never the deployment sandbox key), reservation settle on
finished (row kept, expires shortened, idempotent DB-verified) and stopped
(row deleted), quota exhaustion → BillingAdmissionError 402, checkout
allowlist + `priceIdForPlan` resolution. ALL pre-existing billing/trial/
reservation/hammersmith suites green with zero weakened assertions.

## Adversarial review before merge (child run, 3 reviewers, all PASS)

- reviewer-entitlement / reviewer-security / reviewer-tests (engine
  fornace, model fornace-max) reviewed the full billing delta.
- Confirmed and FIXED pre-merge: (1) P1 dead checkout path
  (`priceIds[plan]` never resolved hammersmith) → `priceIdForPlan`;
  (2) P2 gate ordering → 402 paywall now precedes the 503 credential
  error; (3) dunning hole → `PLANS_WITH_ENTITLEMENT` fix; (4) test
  strengthening (computed reservation amount, DB-verified idempotent
  settle, plan-switch case).
- Documented, deliberately NOT fixed (v1 scope): single-slot subscription
  model (the tier is standalone; a base-plan org switching plans takes the
  hammersmith quota; a multi-item Stripe subscription is rejected by the
  existing single-plan webhook guard); org-less legacy spaces skip billing
  (exact parity with the existing chat-turn policy); cookie-session
  browsers don't receive the capability `hosted` field (capability router
  mounts before session middleware; fail-closed — native Bearer auth and
  the settings endpoint are the authed paths); the priceIds-trap guard
  test runs in one process (env immutability — the structural guard is the
  config comment + code shape).

## Stripe ops — remaining manual steps (live mode)

Production runs live-mode Stripe with the three core prices configured;
`STRIPE_PRICE_HAMMERSMITH` is NOT set (verified on the deploy box, no keys
read or printed). To open sales of the tier:
1. Stripe Dashboard (live): create Product "Hammersmith (hosted)" with a
   recurring monthly Price of $8.99.
2. Set `STRIPE_PRICE_HAMMERSMITH=price_...` in `/opt/waynode/.env` on
   ffrapposerver and restart the service (same pattern as the other
   STRIPE_PRICE_* vars).
Until then, checkout for the plan fails cleanly with "No Stripe price
configured" and every other surface is fully deployed. Webhooks recognize
the price the moment it exists (no redeploy needed for entitlement).
NEVER invent, commit, or print keys — none were.

## Child runs launched + verdicts (all engine fornace / model fornace-max)

- hosted-hammersmith-tier (repo-feature): PASS, attempt 1, 22.5 min.
- hammersmith-dunning-fix (one-task fix): PASS, attempt 1, 2.4 min.
- billing adversarial review (3 reviewers): all PASS, attempt 1.
- billing-review-fixes (one-task fix of confirmed findings): PASS,
  attempt 1, 10.2 min.
- native-hammersmith-surface (repo-feature, isolated clone): PASS,
  attempt 1, 45.6 min.

## Exact passing commands (all executed by me at integration, exit 0)

- `cd /Users/ffrappo/works/repos/waynode && npm test` → exit 0 (final
  merge SHA 6f0dff7, includes test:billing-hammersmith).
- `cd native-app/WaynodeCore && swift test` → 81 tests, 11 suites, pass.
- `xcodebuild -project native-app/Waynode.xcodeproj -scheme WaynodeMac
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build` → BUILD
  SUCCEEDED (also `-scheme Waynode` iOS Simulator → BUILD SUCCEEDED).
- `node scripts/check-file-lengths.mjs` → pass; `git diff --check` → clean.
- `gh run watch 29652795313 --exit-status` → 0 (a2c54f0);
  `gh run watch 29653004412 --exit-status` → 0 (6f0dff7).
- Live probes (above) match origin/main; unauthenticated capability
  payload byte-identical to phase 1.
- `bash /Users/ffrappo/.hammersmith/missions/waynode-hammersmith-deferred/check.sh`
  → CHECK PASS (exit 0).

## Merge lineage on main (phase 2)

a2c54f0 Merge feature/hosted-hammersmith-tier (c4533d5 feature)
6f0dff7 Merge feature/native-hammersmith (a85d4a4 feature) ← origin/main,
        deployed green, live

## Next phase (documented, NOT built)

- STRETCH (explicitly non-blocking, deferred): manifest editor / two-stage
  pi-authored manifests behind the ManifestFactory seam
  (lib/hammersmith-manifest.mjs). Skipped to keep the done-gate honest;
  the seam is untouched and ready.
- xcodegen regeneration of project.pbxproj → then drop the Core-side
  HammersmithRunView/UserBubbleShape twins.
- True add-on model (base plan + hammersmith coexisting on one org) if the
  product wants the tier alongside starter/pro/team.
- APNs milestone pushes + Live Activities per native-app/PLAN.md §9.
