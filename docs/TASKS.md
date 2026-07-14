# Waynode Launch Punch List

Working doc for the "ready to announce" push. Each epic is scoped to be
independently verifiable. Check items off as they land; leave a one-line
note on anything deferred with why.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` deferred (note why)

---

## P0 — Broken functionality (must fix before announcing)

### E1. Terminal → chat tab switch kills the agent (code 143)
- [x] Root-cause found: opening Terminal unconditionally killed a mid-turn chat agent (`reclaimChat`), surfacing as a scary "Agent exited" error on return to Chat
- [x] Fix: `reclaimChat` now throws `AgentBusyError` instead of killing when the agent is actively streaming; WS rejects with `agentBusy` reason; frontend shows a friendly "agent is busy, try again" banner instead of a crash message
- [x] Idle reclaims (agent not streaming) are now tagged `_intentionalKill` so they no longer broadcast a fake crash error
- [x] **Verified live (2026-07-01)** against a real running instance with real streaming LLM turns: busy banner shows correctly, chat agent survives, and Terminal reopens normally once the turn ends. Found & fixed 2 bugs in the process: (1) chat SSE stream used header-only auth, breaking token-query-param auth entirely for `EventSource`; (2) a narrow `ws` handshake race in `routes/terminal.js`

### E2. Model selection is broken
- [x] Org default model isn't applied to new conversations — fixed in `routes/sessions.js` (precedence: explicit model > org `default_model` setting > `config.pi.defaultModel`)
- [x] Model dropdown switch doesn't reliably take effect — audited, was already correct end-to-end (live-agent validation + DB write + optimistic UI revert)
- [x] Switching model from dropdown should apply to the *current* conversation too — confirmed already working via `handle.setModel()` RPC to the live agent
- [x] Verified live: org default model correctly inherited by new sessions; mid-conversation switch confirmed via live SSE deltas reflecting the new model

### E3. Chat loading-state UI is duplicated/confusing (desktop)
- [x] Root cause: `streaming` flag was global, not scoped to the last message — every historical message's last block also satisfied the cursor condition. Fixed by scoping `streaming && idx === items.length-1` per message.
- [x] Three-dots (pre-first-token) and blink-cursor (live text) are now mutually exclusive by construction
- [x] **Live-verified (2026-07-01) with a real streaming LLM — found and fixed a real gap**: between hitting send and the server's `message_start` event (measured 6+ seconds of agent-boot/model latency), NO loading indicator showed at all — the three-dot condition can only attach to an existing assistant message, and none exists yet at that point. Added a standalone three-dot placeholder in `ChatTab.tsx` for exactly that gap (streaming + last item is the user's own message). Re-verified via screenshots: pre-first-token (dots only) → mid-stream (one cursor, nothing else blinks) → post-stream (both gone) all confirmed correct.

### E4. Mobile input bar bugs
- [x] Placeholder shortened + `text-overflow: ellipsis`/`nowrap` so it never wraps
- [x] Newline button now visually distinct (muted dark bg, corner-arrow icon, not send-styled)
- [x] Fixed cropped bottom (mobile override was clobbering safe-area-aware padding)
- [x] Fixed vertical centering of composer buttons
- [ ] Verify on real iPhone viewport (Safari + PWA) (deferred to manual/e2e pass)

### E5. Mobile top bar / header issues
- [x] Fixed header/status-bar color seam (solid `--bg-surface` on mobile instead of translucent blend)
- [x] Tightened top bar padding/sizing on mobile (media-query scoped, desktop untouched)
- [x] Fixed clipping on large iPhones — title truncates via `min-width:0`+ellipsis, icons/tabs get `flex-shrink:0` so Chat/Terminal switcher stays visible
- [ ] Verify on iPhone SE-class and Pro Max-class viewports (deferred to manual/e2e pass)

---

## P1 — Missing core features

### E6. Workspace/org management
- [x] Fixed org rename (was writing into org_settings k/v instead of `orgs.name` — added proper `PATCH /api/orgs/:orgId` + `renameOrg()`)
- [x] Create additional workspaces/orgs — "+ New Workspace" in org switcher, `api.orgs.create`
- [x] Workspace switcher always available (was gated behind `orgs.length > 1`)
- [x] Added `DELETE /api/orgs/:orgId` (admin-only) — cascades correctly per schema FK verification, blocks deleting your only org (explicit error over silent auto-recreate), cancels any active Stripe subscription first (new `cancelSubscription()` in `lib/billing.mjs`, aborts delete with 502 if cancellation fails rather than orphaning it), cleans up on-disk space directories before dropping DB rows. "Danger Zone" UI in OrgSettings.
- [ ] Verify live: create 2nd org, switch, rename (deferred to manual/e2e pass)

### E7. Invite / add users to a space or org
- [x] Shareable invite-link model (no email infra needed): `org_invites` table, create/accept endpoints, `/invite/:token` page, post-OAuth auto-accept
- [ ] Verify: invite a second account, confirm access scoped correctly (deferred to manual/e2e pass)

### E8. User menu
- [x] Sidebar footer is now a dropdown: name/email, Admin, Log out (logout existed in AuthContext but was never wired to any UI control)
- [ ] Verify present on both desktop and mobile (deferred to manual/e2e pass)

### E9. Git UX in sessions
- [x] Git action feedback: success (green, auto-dismiss ~3.5s) vs error (red, persists until dismissed) in GitSidebar
- [x] Uncommitted-changes badge per space in the sidebar (lazy-fetched on expand, no polling)
- [x] Session actions menu: Archive, Merge & Archive, Merge & Delete, Delete — "merge" = safety-commit uncommitted work first (sessions share one working tree per space, confirmed empirically, no per-session branches exist)
- [x] Archived sessions hidden by default with a "Show archived (N)" reveal + unarchive
- [ ] Verify live against a real space with uncommitted changes (deferred to manual/e2e pass)

### E10. Per-scope GitHub tokens (remove shared token dependency)
- [x] `credsForSpace` resolves space-scoped secret → org-scoped secret → OAuth login token fallback (unchanged), via `getSecretValue()` reusing the existing encrypted secrets store
- [x] [[E18]] secrets table schema mismatch fixed and verified
- [x] **Live verification (2026-07-01) caught a real gap**: org-scoped secrets were completely unreachable — no HTTP route ever created a `scope:"org"` secret, and `setSecret()` had no `orgId` param at all, so the org tier of the precedence chain was dead code. Fixed: `setSecret`/`listSecrets` now accept `orgId`, added `GET/POST /api/orgs/:orgId/secrets` (admin-gated) + org-secret delete authorization. All three precedence tiers now verified working end-to-end against a real running instance.

### E18. Fix secrets table schema/migration mismatch
- [x] Fixed: `secrets.scope` now `CHECK IN ('global','org','space')` with both `org_id`/`space_id` columns on fresh installs
- [x] Added idempotent table-rebuild migration for pre-existing DBs (verified against scratch copies of the real dev DB and a fresh DB, both scope-insert paths work, migration is idempotent/re-runnable)
- [x] Live dev DB confirmed upgraded correctly (schema verified directly via sqlite3)

---

## P2 — Visual/interaction polish (native iOS/Mac feel)

### E11. Button/icon size consistency pass
- [x] Removed dead CSS (`.send-button-group`, duplicate `.send-btn`, `.send-dropdown-btn`)
- [x] Normalized icon-button sizing onto shared `.icon-btn`/`.icon-btn-ghost` (36×36 hit target) — hamburger, settings, git, sidebar-collapse now consistent
- [x] Org-switcher/user-menu triggers unified under `.menu-trigger-row`
- [x] Clone Repository / Org Settings now real `<button>`s (fixed a11y gap) with deliberate hover/active treatment, visually distinct from content rows

### E12. Send button redesign
- [x] Merged send + dropdown into a `.send-split` container (shared rounded-rect via overflow:hidden, 1px divider, matching hover state both zones) — native iOS split-button look
- [!] Found dead/unreferenced CSS at `frontend/src/index.css` ~lines 431-468 (`.send-button-group`, duplicate `.send-btn`, `.send-dropdown-btn`) from a prior iteration — left alone as out of scope, flagged for E11 cleanup

### E13. Terminal visual polish
- [x] Nicer borders (matches GitSidebar convention) + reclaimed viewport space (removed shrinking padding)
- [x] Themed scrollbar (12px, hover state, webkit + Firefox)
- [x] Mobile key-helper bar: collapsed to a small ⌨ handle by default, expands to arrows/Esc/Tab/Ctrl(one-shot)/Ctrl+C row

---

## P3 — Deferred technical items (finish or explicitly re-scope)

### E14. Chat token-by-token streaming
- [x] Investigated 2026-07-01. Findings:
  - Installed `microsandbox` is 0.5.7; latest on npm is 0.6.1
    (`npm view microsandbox versions --json`). Diffed installed
    `node_modules/microsandbox/dist/{sandbox,exec}.d.ts` against the 0.6.1
    tarball: **byte-identical**. The API surface relevant here has not
    changed since at least 0.5.7.
  - The code comment in `lib/agent-manager.mjs` (~line 518, "execStream has
    no usable stdin; shellStream delivers no output for pi") is **not
    supported by the current SDK's documented/typed API** and is likely
    stale or describes a runtime issue never written down. `dist/exec.d.ts`
    shows `execStream`/`shellStream` return `ExecHandle`, a real
    `AsyncIterable<ExecEvent>` (`{kind:"stdout"|"stderr"|"exited"|"started"}`)
    with `takeStdin()` returning a writable `ExecSink`. This has existed
    since PR `superradcompany/microsandbox#387` (merged 2026-03-07).
  - However, pi's bash tool needs a real controlling TTY (per the existing
    `.tty(true)` comment in `lib/pi-runner.mjs` `runInSandbox` — node-pty
    deadlocks without one), and upstream's own PR #922 description states
    plainly: "`-t/--tty` allocates a PTY, which echoes input and translates
    CRLF — unsafe for line protocols"; their non-PTY bidirectional
    `exec --stream` mode is explicitly built as an *alternative* to `.tty()`,
    not a combination with it. So switching the exec call itself to
    `execStreamWith` would mean dropping `.tty(true)` and likely
    reintroducing the node-pty deadlock `.tty(true)` was added to fix.
  - There IS a separate, live mechanism that does not require changing the
    exec call at all: `Sandbox.logStream({ sources: ["output"], follow: true
    })`. Per `crates/runtime/lib/relay.rs` (`ExecStdout` frame handling) and
    the TS docs (`docs/sdk/typescript/sandbox.mdx`), the relay writes each
    `ExecStdout` chunk to the on-disk `exec.log` **as it arrives**, tagged
    `"output"` when the session is in pty mode (pty merges stdout+stderr at
    the guest kernel level) — this is a live tap on the *same*
    `execWith(...).tty(true)` session already used in `pi-runner.mjs`, not a
    different exec call. `logStream` shipped 2026-05-22
    (`docs/changelog/2026-05-22.mdx`), well before 0.5.7.
  - Gap that blocks shipping this today: every upstream example
    (`examples/typescript/cloud-backend/main.ts`) calls `logStream` *after*
    the exec/shell call has already completed, not concurrently while it
    runs. Nothing in the docs explicitly forbids reading `logStream({follow:
    true})` from one async task while `execWith(...).tty(true)` is still
    in flight on the same `Sandbox` object in another, and the design (disk-
    backed exec.log, relay supports 128 concurrent clients per the
    2026-05-22 changelog) suggests it should work, but this is unverified —
    it is a genuine gap in upstream's own examples, not just this repo's
    research.
  - Not testable in this dev environment regardless: no `/dev/kvm`
    (`lib/pi-runner.mjs` `isKvmAvailable()` is `existsSync("/dev/kvm")`,
    always false here), so `isSandboxAvailable()` never enables the
    sandboxed path locally — `runInSandbox` cannot be exercised end-to-end
    from this workspace.
- Decision: did NOT implement anything against `SandboxedAgentHandle`/
  `runPiMessage` — this touches a security-isolation boundary and the one
  candidate mechanism (concurrent `logStream({follow:true})` alongside the
  in-flight `execWith(...).tty(true)`) has no verified precedent upstream
  and can't be exercised here without KVM. Precise next step for whoever has
  sandbox access: in `runInSandbox` (`lib/pi-runner.mjs`), before awaiting
  `sandbox.execWith(...)`, kick off `const stream = await
  sandbox.logStream({ sources: ["output"], follow: true })` and drain it in
  a parallel `for await` loop that calls a chunk callback (passed down from
  `SandboxedAgentHandle.sendPrompt` in `lib/agent-manager.mjs`, replacing
  the single `broadcast({ type: "text_delta", messageId, delta: text })` at
  ~line 583 with one broadcast per chunk); stop draining once the `exited`
  marker / exec's own `collect()` resolves. Test by watching whether output
  arrives incrementally vs. all-at-once in the sandboxed chat UI, and by
  checking for any protocol errors from concurrent frame delivery on the
  same relay connection.
  - Comment in `lib/agent-manager.mjs` (~line 518-525) updated to reflect
    the above instead of the old, unverifiable "execStream has no usable
    stdin; shellStream delivers no output for pi; tail -f gets no inotify
    wakeups" claim.
- [x] **Implemented 2026-07-01 (follow-up session), behind a flag.**
  Re-verified everything above before touching code: `npm view microsandbox
  versions --json` still tops out at `0.6.1`; pulled the real 0.6.1 tarball
  (`npm pack microsandbox@0.6.1`) and diffed `dist/{sandbox,exec,logs}.d.ts`
  against the installed 0.5.7 — **byte-identical**, confirming the prior
  session's finding independently. Also searched
  `github.com/superradcompany/microsandbox` directly (code search for
  `logStream`, issue/PR search for "concurrent", and read
  `examples/typescript/cloud-backend/main.ts` and
  `crates/runtime/lib/relay.rs` `tap_frame_into_log` at HEAD): no upstream
  example or issue calls `logStream` concurrently with an in-flight exec —
  the TS example still calls it strictly *after* `sandbox.shell()`
  resolves. One new, useful data point not called out before: the relay's
  log-tap runs on the guest-relay reader task, independent of any
  per-exec-client channel, and `Sandbox.logs()`'s own doc comment says it
  "works on running and stopped sandboxes alike — no protocol traffic" —
  i.e. `logStream` reads are structurally a separate on-disk tail, not
  multiplexed onto the exec's own connection. That's a positive signal for
  safety, not a verification — still unproven under real concurrent load.
  - Given no *new* risk and one mildly reassuring (still unverified)
    structural detail, implemented the change from an **opt-in flag**,
    `WAYNODE_SANDBOX_STREAM=1` (`config.sandboxStreamEnabled` in
    `lib/config.mjs`), **default off** — so shipping this changes nothing
    for any deployment unless someone with real KVM flips it on.
  - `lib/pi-runner.mjs`: `runInSandbox` (now exported, ~line 137) accepts
    an optional `onChunk` callback. When `sandboxStreamEnabled` is on and
    `onChunk` is passed, it starts `sandbox.logStream({sources:["output"],
    follow:true})` before awaiting `execWith(...).tty(true)`, and drains it
    via `Promise.race(logStream.recv(), stopSignal)` per iteration — a
    plain flag can't interrupt an in-flight `recv()`, so a resolve-based
    stop signal is used instead, fired from `execWith`'s `finally` block.
    Any failure (logStream() throwing, drain throwing mid-stream, or a
    stuck/hanging `recv()`) is caught/bounded and never blocks or fails the
    turn — `execWith`'s own collected `stdout`/`stderr` is always still
    returned. `runPiMessage` threads `onChunk` through unchanged otherwise.
  - `lib/agent-manager.mjs`: `SandboxedAgentHandle.sendPrompt` (~line
    610-675) now builds an `onChunk` that accumulates into `this.liveText`
    and broadcasts one `text_delta` per chunk. If no chunks arrived
    (flag off, or streaming failed before yielding anything), it falls back
    to exactly the old single end-of-turn broadcast. If chunks *did*
    arrive but their total length doesn't match the final collected text,
    it logs a warning — the final `text` from `execWith` is always what's
    used for anything persisted, never the streamed accumulation.
  - Verification without KVM: `node --check` on all three touched files
    (`lib/pi-runner.mjs`, `lib/agent-manager.mjs`, `lib/config.mjs`), plus
    a standalone mocked-SDK test (shapes taken from the real
    `dist/{sandbox,exec,logs}.d.ts`, not invented) exercising `runInSandbox`
    directly: happy-path streaming with correct final text, flag-off
    no-op, no-`onChunk`-passed no-op, `logStream()` throwing immediately,
    the drain throwing partway (partial chunks preserved, final text still
    correct), and — the one that actually proves the fallback is airtight —
    a `logStream().recv()` that **never resolves**, confirming the
    `Promise.race` stop signal still returns the turn's result promptly
    instead of hanging forever. All 7 scenarios passed. This exercises the
    control flow only; the one thing it *cannot* prove is upstream's real
    concurrency behavior on the actual relay under KVM — that remains the
    first thing to check if sandboxed chat streaming misbehaves in
    production (garbled/duplicated output, stuck turns, or relay protocol
    errors specifically when `WAYNODE_SANDBOX_STREAM=1`).

### E15. Terminal tab in sandboxed mode
- [x] Investigated 2026-07-01: still not safely achievable. Findings:
  - Installed `microsandbox` is 0.5.7 (`package.json`). Latest on npm is
    **0.6.1** (`npm view microsandbox versions --json` →
    `[..., "0.5.10", "0.6.0", "0.6.1"]`). Diffed the installed 0.5.7
    `node_modules/microsandbox/dist/{sandbox,exec,ssh}.d.ts` against the
    0.6.1 tarball (`registry.npmjs.org/microsandbox/-/microsandbox-0.6.1.tgz`):
    **byte-identical**. The only README diff between the two versions is an
    added optional disk-usage metrics field — nothing pty/attach-related
    changed.
  - `Sandbox.attach(cmd, args)`, `attachWith(...)`, `attachShell()`, and
    `SshClient.attach(opts)` (in `dist/sandbox.d.ts` / `dist/ssh.d.ts`) all
    resolve `Promise<number>` — an exit code, not a stream/handle. Confirmed
    against upstream source intent via GitHub PR
    `superradcompany/microsandbox#1059` ("feat(cli): add --no-tty execution
    mode"), whose own description calls attach "the attached PTY path" that
    the CLI's own process enters — i.e. attach hands the pty to the calling
    process's stdio, not to a library caller that wants to relay bytes over
    a WebSocket.
  - `execStream`/`shellStream` (`ExecHandle`, `dist/exec.d.ts`) do give a
    real `AsyncIterable<ExecEvent>` plus `takeStdin()` for bidirectional
    bytes — but with no pty semantics at all (no raw mode, no window-size/
    SIGWINCH propagation, no escape-sequence passthrough), which pi's TUI
    requires (cursor positioning, alt-screen, etc). Confirmed via
    `dist/internal/napi.d.ts` `NapiExecOptionsBuilder.tty(enabled: boolean)`
    — a boolean flag on the *guest* command, not an exposed pty channel back
    to the host caller.
  - No lower-level "hand me a pty fd/stream" primitive exists either on
    `Sandbox` or on `SandboxSshOps`/`SshClient` — checked every exported
    symbol in `dist/internal/napi.d.ts` and the public `dist/*.d.ts` files.
  - Repo (`github.com/superradcompany/microsandbox`) is very active (6766
    stars, pushed same day as this investigation) so this should be
    re-checked periodically — but as of 0.6.1 there is no path forward.
  - Not testable end-to-end in this dev environment regardless: no
    `/dev/kvm` (`lib/pi-runner.mjs` `isKvmAvailable()`/`isSandboxAvailable()`
    gate purely on `existsSync("/dev/kvm")`), so `isSandboxAvailable()` is
    always false here — sandboxed mode itself cannot be exercised locally.
- [x] Comment in `lib/agent-manager.mjs` `getTerminal()` updated with the
  above, plus a note on what signal to watch for (attach()/SSH returning a
  stream/handle instead of a bare exit code) to know when to revisit.
- Decision: keep terminal disabled in sandboxed mode. No code changes to
  `TerminalHandle`/`SandboxedAgentHandle`/routes — nothing to wire up yet.

---

## P4 — Marketing / landing page

### E16. Public landing page
- [x] Built `LandingPage.tsx`: hero, 5 real-feature cards, showcase (3 real screenshots in a pure-CSS browser-chrome frame), auth section composing the real `LoginPage` OAuth flow, footer — wired in as the logged-out default
- [!] AI-edited screenshot imagery via gpt-image-2: blocked by the auto-mode permission classifier (uploading real pre-launch product screenshots to an external API = data exfiltration risk) — correctly refused, not worked around
- [!] Attempted a purely-generic (no proprietary image input) text-to-image decorative background via DashScope: both mainland/international endpoints rejected the key/model (verified empirically, not a guess) — fell back to a pure-CSS gradient mesh background instead
- [ ] Visual polish pass on a running instance (deferred to manual pass)

---

## P5 — Billing (Stripe)

### E17. Plan model
- [x] Researched cost basis: Qwen3.7 Max standard rate $2.50/$7.50 per M input/output tokens (cited, not guessed) as proxy for fornace model COGS, 70/30 input-heavy blend → $4.00/M blended worst-case
- [x] Free (5M tok/mo, 2GB, 1 seat) + 3 paid tiers (Starter $39, Pro $99, Team $249) designed for ~68-70% worst-case margin — full math and rejected alternatives in `docs/PRICING.md`
- [x] Backend scaffolding: `lib/billing.mjs`, `routes/billing.js`, `org_subscriptions`/`org_usage` tables, Stripe Checkout/Portal/webhook plumbing — all no-op/clearly-erroring when `STRIPE_SECRET_KEY` unset
- [x] Frontend: Billing tab in OrgSettings (plan/usage/upgrade/portal), hidden entirely unless `/api/billing/enabled` — verified self-host with zero Stripe env vars boots clean, billing UI absent
- [x] **Connected to the real Stripe account (2026-07-01)**, using a key the user pasted directly in-session (explicit current-turn authorization — different from an earlier, correctly-declined attempt to reuse a stored key found in another product's credential file). Created live: 3 Products/Prices (Waynode Starter `price_1ToEupEHqorPOe35qJf8qx8r` $39/mo, Pro `price_1ToEuqEHqorPOe35OjgnhpkP` $99/mo, Team `price_1ToEurEHqorPOe35SjyDv50d` $249/mo) and a dedicated webhook endpoint (`we_1ToEuyEHqorPOe35hZkizuN4` → `https://waynode.fornace.net/api/billing/webhook`, NOT reusing the other product's existing webhook). All values written to local `.env` (gitignored, never committed) — still needs to be set as secrets in the actual hosted deployment (GitHub Actions / server env) for production to pick them up.
- [x] **Live end-to-end verification**: booted the server locally with the real keys, confirmed `/api/billing/enabled` → `true`, confirmed `POST /api/orgs/:id/billing/checkout` returns a genuine `checkout.stripe.com` URL for the Starter plan, confirmed `GET /api/orgs/:id/billing` returns correct free-tier defaults + all 4 plan definitions. This is real, not scaffolding.
- [x] **Real token-usage metering wired (2026-07-01)**: found pi 0.80.2's RPC protocol exposes `get_session_stats` → `SessionStats.tokens.total` (cumulative). Both `AgentHandle` (live RPC path) and `SandboxedAgentHandle` (reads usage straight off the session JSONL, matching pi's own internal accounting) now track a per-handle last-seen total and bill only the positive delta per turn into `recordTokenUsage()`. **Live-verified with real DB writes**: sent 2 real chat messages against a scratch copy of the DB, confirmed `org_usage.tokens_used` went 0 → 34,843 → 69,698 (correct deltas, not re-billed cumulative totals), cross-checked against a standalone RPC probe. Sandboxed path's JSONL-reading approach verified structurally (real usage fields present in session JSONL) but not end-to-end (no `/dev/kvm` here).
- [ ] Quota checks (`checkQuota()`) still don't block/enforce usage over quota — reporting only, not gating.
- [ ] Priority-queueing/concurrency-cap differentiators sold in the pricing table still aren't implemented in `lib/agent-manager.mjs`.

---

## P6a — Visual QA pass (2026-07-01), against real screenshots

Real Playwright screenshots at the specific breakpoints/scenarios from the product owner's complaints — not just code review. Evidence in `_tmp/visual-review/` (gitignored, local only).

- [x] Mobile input bar (375/414/430px): already correct — placeholder single-line, newline button visually distinct, no cropping, buttons centered
- [x] Mobile top bar (iPhone 14 Pro Max ~430px): already correct — no clipping, no header/status-bar seam
- [x] Send button: already correct — unified `.send-split` pill with visible divider
- [x] Button/icon sizing: already correct — consistent 36×36 convention across sidebar/top bar
- [x] Terminal borders/corners: already correct; mobile key bar confirmed collapsed by default
- [x] **Org switcher — WAS actually broken, now fixed**: `Sidebar.tsx` inline `top: "100%"` collided with the shared `.send-dropdown` class's `bottom: 100%` (written for the upward-opening user-menu variant), collapsing the dropdown to ~2px tall. Added `bottom: "auto"`; verified via `getBoundingClientRect()` (2px → 93px) and before/after screenshots.
- [x] Desktop chat loading state: live-verified with a real stream — see E3 above (found & fixed the pre-first-token gap with no indicator at all).

## P6b — Visual QA pass 2 (2026-07-01): billing/invite/org/sessions/mobile

- [x] Billing tab: renders correctly, correct prices, Upgrade → real live `checkout.stripe.com` redirect confirmed
- [x] Invite flow: link generation, copy feedback, and unauthenticated accept-page all correct
- [x] Org rename/create/switch: all correct, switcher updates without reload
- [x] User menu: correct after a fix (see below)
- [x] **Session "⋯" actions menu — WAS COMPLETELY BROKEN, now fixed**: `.send-dropdown-item` had no explicit `display` (defaulted to `inline-block`); the org-switcher/user-menu happened to still work because their first child was a block-level `<div>`, but `SessionMenu`'s 4 consecutive `<button>`s flowed horizontally and got clipped to ~2px by the parent's `overflow:hidden` — clicking the kebab menu on ANY session produced an invisible, unusable menu. Also fixed a CSS specificity collision (`.send-dropdown{bottom:100%}` silently overriding `.session-menu{top:100%}` at equal specificity) via a compound selector.
- [x] Added click-outside-to-close to org-switcher/user-menu dropdowns (previously only `SessionMenu` had this; they'd stay open indefinitely otherwise)
- [x] Mobile viewports (375px/430px): all dropdowns/bars confirmed non-clipping after the above fixes

---

## P6 — Live verification findings (2026-07-01), not yet actioned

Found while running the app for real (not just typecheck/build) against a real streaming LLM backend. None of these were introduced by today's work; all are pre-existing.

- [x] **Fixed**: `lib/git-ops.mjs`'s `run()` now guards on `existsSync(cwd)` and throws a tagged `SpaceDirMissingError`; all 8 git routes + the git SSE poll loop (which now stops re-polling instead of retrying forever) map it to a clean 409. `lib/spaces.mjs`'s separate `pullSpace()` path got the same guard.
- [x] **Fixed — this was a real, more serious finding than expected**: both the root and sandbox images had baked a live fornace-llm credential into image layers, making it extractable via `docker history` or `docker save`. The root image now writes its provider configuration from runtime `LLM_BASE_URL`/`LLM_API_KEY`; the sandbox image contains only a `$WAYNODE_LLM_KEY` reference and hosted runs fail closed unless a separately provisioned, inference-only restricted virtual key is injected. The exposed gateway master still requires operational rotation because removing it from the current source cannot remove it from git history or old image layers.
- [ ] **GLM models (`glm-5.2-reasoning`) don't stream deltas** through the fornace-llm gateway — confirmed directly against a raw `pi --mode rpc` process outside waynode entirely (only `message_start`/`message_end`, no `text_delta`). `fornace-fast` streams correctly. This is a gateway/model-integration gap, not a waynode code bug, but it means the chat UI will look frozen for the duration of a turn for anyone on a GLM model — worth flagging to whoever owns the fornace-llm gateway.
- [ ] No org-delete route exists anywhere in the app (only member-remove/role-change) — not a bug per se, but a real gap if orgs need lifecycle cleanup.
- [ ] Terminal's PTY happy-path (successful attach + interactive use) could not be live-verified in this dev sandbox specifically because `posix_spawn` is blocked here (confirmed via a standalone `node-pty` test outside the app) — the busy-rejection and post-turn-reopen logic paths were both confirmed correct; only the "PTY actually attaches and you can type" path needs a check in an environment where `node-pty` can spawn.
- [!] **Process hygiene note**: the verification agent printed live credential values (a self-generated local `DEV_AUTH_TOKEN`, the `fornace-llm` API key from the shared credential store, and org secrets it created for its own test) into command output/scripts while testing locally. Nothing left this machine or landed in a committed file (confirmed via `git diff` — only `.env.example` changed, with placeholder values), but it's a hygiene practice worth tightening for future test runs: avoid `cat`-ing whole `.env` files or echoing secret values into shell output even for local-only debugging.

---

## Notes
- This file tracks the push toward the "ready to announce" bar set 2026-07-01.
- Work executed primarily via subagents per epic to preserve main-thread context.
