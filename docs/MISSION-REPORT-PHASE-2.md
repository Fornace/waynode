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

## Stripe ops — COMPLETED 2026-07-19 (live mode)

Production runs live-mode Stripe with the three core prices configured.
The tier is fully armed:
1. Stripe Dashboard (live): Product "Waynode Hammersmith"
   (`prod_UuYAUIf1Wl0Dlg`) with recurring monthly Price $8.99
   (`price_1Tuj47EHqorPOe35bWMJSyIP`, nickname hammersmith) — created via
   the Stripe API on the deploy box (key never left the host).
2. `STRIPE_PRICE_HAMMERSMITH=price_1Tuj47EHqorPOe35bWMJSyIP` set in
   `/opt/waynode/.env`; container recreated with WAYNODE_REVISION pinned
   (manual `compose up` without it reports "development" on
   /api/health/version).
Verified inside the running container: `priceIdForPlan("hammersmith")`
resolves to the live price. Webhooks recognize it via the stitched
matcher; dunning revokes via PLANS_WITH_ENTITLEMENT. No keys were
invented, committed, or printed.

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
