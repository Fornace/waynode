# Waynode Native — iOS & macOS App Plan

> A native SwiftUI app (iOS 17+ / macOS 14+) that drives the Waynode server.
> **Work continues even when the app is fully killed** — because the work never
> lived on the device. The app is a *control + observation* surface over a
> server-side execution engine.

Status: **Draft for review** · Date: 2026-07-06 · Owner: Francesco

---

## 1. The one hard constraint (read this first)

> *"If the app is closed and completely killed, work should continue."*

This single requirement dictates the entire architecture, so it's worth being
precise about what iOS actually allows. Grounded against Apple's WWDC25
"Finish tasks in the background" session and current docs (iOS / iPadOS 26, as
of 2026-07-06):

| What you might want | Reality on iOS |
|---|---|
| Run an agent for minutes→hours after the app is killed | ❌ Impossible. A killed app runs no code. The system suspends then terminates. |
| `BGTaskScheduler` (app refresh) | ⚠️ Finite ~30s windows, **discretionary**, system-chosen timing. Not for real work. |
| iOS 26 `BGContinuedProcessingTask` | ⚠️ New in 26; lets you *finish* a finite task on fg→bg transition (even w/ background GPU). Still bounded, still not indefinite. |
| **Background Push Notifications** ("silent push") | ⚠️ Wake the app to fetch content, but are **discretionary + low-priority** — coalesced and delayed by the system. Not a reliable real-time channel. |
| **Server runs the work; device shows notifications** | ✅ This is the only model that satisfies the requirement. |

**Conclusion (the root-cause insight):** "Work continues when killed" is *not*
a client-side problem and never can be on iOS. It is a **server-residency**
problem. Lucky for us — **Waynode's server already does exactly this.**

The agent already lives in `AgentManager` (`lib/agent-manager.mjs`), the message
endpoint is already **fire-and-forget**, and the code already says, verbatim:

> *"closing this connection does NOT stop the agent — it keeps running and can
> be re-attached."*

So the native app isn't asking the platform to do something impossible. It's
doing three things the server already supports, plus **three additions** that
are the real work of this project:

1. ✅ (exists) Submit work to a server-resident agent.
2. ✅ (exists) Re-attach to a live stream; detach without killing work.
3. ✅ (exists) Re-hydrate full history from on-disk JSONL on cold start.
4. ➕ **API-token auth** (cookies don't fit a native app + APNs).
5. ➕ **APNs milestone notifications** (so a killed app still tells you when work
   finishes, errors, or hits a goal).
6. ➕ **The native UI itself.**

Everything else is a beautiful client over an API that already exists.

---

## 2. Vision

A fast, native, mobile-first Waynode you keep in your pocket and your dock:

- **Fire a goal from your phone**, lock the screen, get a push when it's done
  (or when it's stuck). Reopen to a full transcript that was never interrupted.
- **Watch long runs** as a Live Activity / Dynamic Island progress chip on iOS,
  a menu-bar timer on macOS.
- **A real terminal** in your pocket (xterm-grade, over the existing WebSocket).
- **One codebase**, iOS + macOS, SwiftUI + Swift 6 + The Composable Architecture.

It is **not** a thin webview. It is not on-device pi (the Mac *could* do that
later — see §10). It is the canonical Waynode experience, native.

---

## 3. Architecture

```
┌─────────────────────────────┐                ┌──────────────────────────────────┐
│  Native App (iOS / macOS)   │                │  Waynode Server (existing + add) │
│                             │                │                                  │
│  SwiftUI + Observation      │   REST (JWT)   │  Express                         │
│  TCA reducers ──────────────┼───────────────►│  /api/spaces /sessions /git ...  │
│                             │                │                                  │
│  SSE client (URLSession) ◄──┼──── SSE ───────┤  /api/sessions/:id/stream        │
│   ↳ events → reducer → UI   │                │        ▲                         │
│                             │                │        │ subscribe/detach         │
│  WS terminal ◄──────────────┼──── WS ────────┤  /ws/terminal                    │
│                             │                │        │                         │
│  APNs (UserNotifications) ◄─┼── push ────────┤  NotificationDispatcher (NEW)    │
│   ↳ tap → deep link → cold  │                │        ▲                         │
│      rehydrate from disk    │                │        │ milestone/complete/err  │
│                             │                │  AgentManager (server-resident)  │
│  Keychain (token)           │                │   ↳ pi -p headless, survives     │
│  SwiftData (cache only)     │                │      client disconnect;          │
│  ActivityKit (Live Activity)│                │      idle-reaped @ 30min         │
└─────────────────────────────┘                │   ↳ JSONL on disk (source of     │
                                                 │      truth; cold rehydrate)      │
                                  APNs ────────►│  apns.mjs (NEW)                  │
                                                 └──────────────────────────────────┘
```

**Source of truth:** the server's on-disk pi JSONL + SQLite. The app's SwiftData
store is a **cache**. On every cold start and every background wake it
re-derives state from `/messages` + `/goal` + `/state`. This is what makes
"app killed → reopen → everything's there" trivial.

---

## 4. Tech stack ("new architectures")

| Layer | Choice | Why |
|---|---|---|
| UI | **SwiftUI + `@Observable`** (iOS 17+ / macOS 14+) | Native, performant, cross-platform. Observation replaces `ObservableObject`. |
| State / logic | **The Composable Architecture (TCA)** | Production-grade. An SSE event stream → state reducer is *literally* TCA's model. Composable, testable, perfect fit. |
| Concurrency | **Swift 6 strict concurrency** | `Sendable` actors for the SSE/WS clients; no data races. |
| Networking | `URLSession` + `URLSessionWebSocketTask`; a tiny **SSE parser** (~80 LOC) on `URLSession` bytes | No third-party HTTP dep. SSE = the existing chat/git streams. |
| Persistence | **SwiftData** (cache), **Keychain** (token) | Server is source of truth, so local schema is simple → SwiftData's 2026 maturity is fine here. GRDB is the fallback if migrations bite. |
| Notifications | **APNs** + `UserNotifications` + **ActivityKit** (Live Activities / Dynamic Island) | Push = "work finished while you were away." Live Activity = "watch it run" on the lock screen. |
| Terminal | `SwiftTerm` (or a thin VT100 in SwiftUI) over the existing `/ws/terminal` | Reuses the server pty that already survives client disconnect. |
| Auth | **API tokens** (Bearer) + Sign in with GitHub/GitLab via **ASWebAuthenticationSession** (OAuth) | The server today is session-cookie + dev-token. Native needs tokens (§6). |
| Deep links | Universal Links (`waynode.fornace.net/s/<space>/<session>`) | Tap a push → open the exact session, cold-rehydrated. |

**Minimum deployments:** iOS 17.0, macOS 14.0. One Xcode project, two targets,
shared `WaynodeCore` package (models, API client, TCA reducers).

---

## 5. How "work continues when killed" actually works (the centerpiece)

Three lanes, by app state:

### Lane A — App in foreground (live)
```
POST /api/sessions/:id/message {prompt, isGoal}   → fire-and-forget (200 ok)
GET  /api/sessions/:id/stream                     → SSE: sync snapshot, then tokens/status/errors
```
The agent runs on the server. Tokens stream into a TCA reducer. If you navigate
away, only the SSE subscriber detaches — **the agent keeps running** (existing
behavior, `agent-manager.mjs`).

### Lane B — App backgrounded or killed (the requirement)
The agent **does not know and does not care** — it's on the server. Two things
make the *user* stay informed:

1. **Live Activity (while recently backgrounded):** an ActivityKit widget shows
   goal progress / current step on the lock screen + Dynamic Island, fed by the
   SSE stream while it's connected, and refreshed on wake.
2. **APNs push (when killed):** the server's new `NotificationDispatcher`
   (§7.3) watches agent events and fires a push on:
   - **turn complete** (a normal message finished)
   - **goal complete** (`update_goal(complete)` seen in JSONL)
   - **error / agent exited** (non-zero exit)
   - **idle-reaped** (agent killed after 30min idle — "your run was stopped")
   - *(optional)* **milestone lines** matching the existing task-observability
     convention (saved, done, oom, killed…)

   > Background pushes are "discretionary" on iOS, so for *time-sensitive*
   > milestones (errors, goal-complete) we send them as **normal, high-priority
   > pushes** (visible alert + badge), not silent pushes. Silent pushes are only
   > used opportunistically to refresh the cache.

Tap the push → Universal Link → app cold-launches → rehydrates from
`/messages` + `/goal` + `/state` → you land in the finished transcript.

### Lane C — Cold launch (recover everything)
On launch, for the focused session (and recent ones), the app fetches:
```
GET /api/sessions/:id/messages   → full transcript from on-disk JSONL
GET /api/sessions/:id/goal       → goal status
GET /api/sessions/:id/state      → is anything running right now?
```
If `state.active` → immediately open `/stream` and pick up live. If not → render
the finished transcript. **No data is ever lost, because it was never on-device.**

---

## 6. Server-side additions (the real work, scoped to the existing codebase)

These are the only backend changes. Everything else in the app already has an
endpoint (see the API map in §8).

### 6.1 API tokens (new) — `routes/tokens.js` + `lib/db.mjs`
Cookies don't survive a killed app and can't carry APNs device registration.
Add a `tokens` table and Bearer auth that sits *alongside* the existing
session/dev-token paths (no rewrite of `requireAuth`).

```sql
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,          -- uuid
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,                       -- "Francesco's iPhone"
  token_hash   TEXT NOT NULL,              -- sha256(opaque secret); store NO plaintext
  last_used_at TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
```

- `POST /auth/native/token` — exchanges an **existing session** (from the OAuth
  web flow completed via `ASWebAuthenticationSession`) for an opaque API token.
  Returns the plaintext **once**. Hash stored.
- `POST /auth/native/refresh` — rotate.
- `DELETE /api/tokens/:id` — revoke.
- `GET /api/tokens` — list (labels + last-used), for a "devices" screen.
- Middleware `bearerAuth`: `Authorization: Bearer <token>` → hash → lookup →
  set `req.user`. **Plumbed into `requireAuth` as a first-class third path**
  (session-cookie → dev-token → bearer), so every existing route is instantly
  available to the native app with zero per-route changes.

### 6.2 Device registration for APNs (new) — `routes/devices.js`
```sql
CREATE TABLE push_devices (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_token TEXT NOT NULL,              -- APNs device token (hex)
  platform     TEXT,                        -- 'ios' | 'macos'
  label        TEXT,
  registered_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, device_token)
);
```
- `POST /api/devices` `{deviceToken, platform, label}` (upsert, bearer-authed).
- `DELETE /api/devices/:deviceToken`.

### 6.3 Notification dispatcher + APNs sender (new) — `lib/apns.mjs` + hook into `AgentHandle`
The cleanest seam is the existing `handle.broadcast(ev)` path (already the single
fan-out point for `status` / `error` / completion). Add a dispatcher that:

1. Inspects certain broadcast events + agent lifecycle (exit code, idle-reap,
   goal completion read from JSONL).
2. Resolves the session → owner → registered `push_devices`.
3. Sends via APNs (token-based auth, `.p8` key in env). Uses **push type
   `alert`** for user-visible milestones, **`background`** only for cache refresh.

Config (env): `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY_PATH`,
`APNS_BUNDLE_ID` (`ai.waynode.app` or similar). No-op if unset (same pattern as
billing).

### 6.4 SSE auth for native (trivial)
SSE/WS already accept `?t=<devToken>` for `EventSource` (can't set headers).
Extend that same `sseAuth` helper to accept a **short-lived signed ticket**
derived from the bearer token (since `EventSource` can't send
`Authorization`). Concretely: `GET /api/sessions/:id/stream?ticket=<jwt>`
where `ticket` is minted by the app from its bearer token via a tiny
`POST /auth/native/ticket` endpoint. One existing helper, one new 10-line route.

> Net backend diff: **3 small files + 2 tables + 1 middleware path**. No changes
> to the agent, the stream, or the terminal. The hard part (server-resident,
> disconnect-surviving agent) is already done.

---

## 7. API map (what the app consumes — almost all pre-existing)

| Feature | Endpoint | Exists? |
|---|---|---|
| Spaces list/get/create/delete/pull | `/api/spaces*` | ✅ |
| Clone progress (SSE) | `/api/spaces/:id/clone-events` | ✅ |
| Sessions list/get/create/delete/archive | `/api/spaces/:id/sessions`, `/api/sessions/:id` | ✅ |
| **Send message** (fire-and-forget) | `POST /api/sessions/:id/message` `{prompt,isGoal}` | ✅ |
| Queue follow-up | `POST /api/sessions/:id/queue` | ✅ |
| Abort turn | `POST /api/sessions/:id/abort` | ✅ |
| Switch model (live RPC) | `POST /api/sessions/:id/model` | ✅ |
| **Live stream** (SSE) | `GET /api/sessions/:id/stream` | ✅ |
| **Messages** (disk rehydrate) | `GET /api/sessions/:id/messages` | ✅ |
| **Is running?** | `GET /api/sessions/:id/state` | ✅ |
| **Goal status** | `GET /api/sessions/:id/goal` | ✅ |
| Git status/diff/commit/branch/pull/push/merge | `/api/spaces/:id/git*` | ✅ |
| Models | `GET /api/models` | ✅ |
| **Terminal** (WebSocket) | `/ws/terminal?sessionId=` | ✅ |
| Resolve short-id deep links | `/api/resolve` | ✅ |
| **API tokens / bearer** | `/auth/native/*`, `/api/tokens` | ➕ new |
| **Push device register** | `/api/devices` | ➕ new |

---

## 8. App structure

```
Waynode/                      (Xcode workspace)
├── WaynodeCore/              (Swift package — shared iOS/macOS)
│   ├── Models/               Space, Session, Message, GoalStatus, GitSnapshot (Codable, @Observable)
│   ├── Networking/
│   │   ├── APIClient.swift       Bearer-authed URLSession wrapper; mirrors frontend api/client.ts
│   │   ├── SSEClient.swift       ~80-LOC SSE over URLSession bytes → AsyncStream<Event>
│   │   ├── TerminalSocket.swift  URLSessionWebSocketTask wrapper
│   │   └── Auth.swift            Keychain token store + ticket minting
│   ├── Reducers/ (TCA)
│   │   ├── AppReducer            auth bootstrap, spaces list
│   │   ├── SessionListReducer
│   │   ├── ChatReducer           SSE events → message state; send/queue/abort; goal mode
│   │   ├── TerminalReducer
│   │   └── GitReducer
│   ├── Persistence/          SwiftData cache (server-authoritative)
│   ├── Notifications/        APNs registration, deep-link handling
│   └── LiveActivity/         ActivityKit widget for goal progress
├── Waynode-iOS/              (app target)
└── Waynode-macOS/            (app target + menu-bar helper)
```

### Screens (mobile-first)
1. **Spaces** — list, clone-new (paste repo URL), clone progress.
2. **Sessions** — per space; swipe to archive/delete; goal badge.
3. **Chat** — transcript, streaming tokens, dual send (Normal / **Goal**),
   model picker, abort, queue indicator. The hero screen.
4. **Terminal** — full pty (lazy-loaded, killed on dismiss — mirrors the web app).
5. **Git** — status, diff viewer, commit sheet, branch switch, push.
6. **Settings** — account, **devices/tokens**, model default, notification prefs.

### macOS extras
- **Menu-bar item**: active-goal timer + "open session" quick action; survives
  app quit via a **LaunchAgent** keep-alive (this is the one place a *watcher*
  stays alive locally — it still just polls the server, it does not run pi).
- **Live terminal in a window**, keyboard-first.

---

## 9. Notifications & Live Activities design

| Trigger | Channel | Priority | Copy |
|---|---|---|---|
| Normal message turn complete | APNs `alert` | normal | "Waynode finished a turn in *<session>*" |
| **Goal complete** | APNs `alert` | **time-sensitive** | "✅ Goal complete: *<title>*" |
| Agent error / non-zero exit | APNs `alert` | **time-sensitive** | "⚠️ Run hit an error: *<summary>*" |
| Idle-reaped (30min) | APNs `alert` | normal | "Run stopped (idle 30m): *<session>*" |
| Milestone line (saved/done/…) | APNs `alert` (opt-in) | normal | milestone text |
| Cache refresh | APNs `background` | discretionary | (silent) |

**Live Activity** (iOS 17+): started when a **goal** begins; updated as the SSE
stream emits progress; ended on complete/abort/error. Shows on lock screen +
Dynamic Island. This is the "watch your agent work while the phone is in your
pocket" moment.

Notification preferences are per-user (server `settings`) so they sync across
devices: *which* events, quiet hours, etc.

---

## 10. (Future, out of scope for v1) Local agent on macOS

A Mac *can* run pi locally and a `LaunchAgent` can keep it alive after app quit.
That would give true "offline-capable, always-running" on the Mac. **Defer.**
v1 keeps both platforms server-driven for one consistent model and one source
of truth. We revisit once the client is shipped and stable.

---

## 11. Phased roadmap

| Phase | Goal | Deliverable |
|---|---|---|
| **0 — Server prep** (1–2 d) | Native-ready auth + push plumbing | `api_tokens` + `push_devices` tables, `bearerAuth` in `requireAuth`, `/auth/native/token`, `/api/devices`, `lib/apns.mjs` stub. All behind env flags, no behavior change if unset. |
| **1 — Walkthrough skeleton** (2–3 d) | Auth + read-only parity | `ASWebAuthenticationSession` → token in Keychain; spaces/sessions/messages screens; **cold rehydrate** working; no live stream yet. Proves the "killed app → reopen → full history" promise on a real device. |
| **2 — Live chat** (2–3 d) | The hero feature | SSE client → TCA `ChatReducer`; send/queue/abort; model picker; streaming UI. |
| **3 — Continue-when-killed** (2–3 d) | The headline requirement | `NotificationDispatcher` wired to `AgentHandle` events + exit/reap; APNs live; deep links; **Goal complete** push verified end-to-end with a force-killed app. |
| **4 — Terminal + Git** (3–4 d) | Parity with web | Terminal over `/ws/terminal`; Git status/diff/commit/push. |
| **5 — Live Activities + polish** (2–3 d) | Delight | ActivityKit goal widget, Dynamic Island, menu-bar (macOS), notification prefs, haptics. |
| **6 — Beta + TestFlight** (1 wk) | Real use | Internal TestFlight → Francesco daily-driving; iterate. |

~3–4 weeks of focused work to TestFlight.

---

## 12. Risks & open questions

| Risk / Question | Mitigation / Default |
|---|---|
| **APNs reliability** for "discretionary" background pushes | Use **alert** pushes (not silent) for anything the user must see; silent only for cache refresh. Document that iOS throttles coalesced silent pushes. |
| **`EventSource` can't send `Authorization`** | Short-lived signed `?ticket=` for the SSE/WS routes (§6.4). Already half-supported via the `?t=` dev-token path. |
| **SwiftData migration maturity (2026)** | Local store is a *cache*, droppable anytime — worst case we wipe and rehydrate from server. GRDB as fallback. |
| **Terminal UX on phone** | Collapsible keyboard bar, gesture shortcuts; default to Chat, terminal opt-in. |
| **Multi-account / org scoping** | Reuse server's org/space membership; token is user-scoped; org picker on launch. |
| **App Store subscriptions** | Hosted entitlement must be server-verified and bound to an org through a short-lived `appAccountToken`; do not add a client-only StoreKit purchase flow. See [`docs/storekit-entitlement-contract.md`](docs/storekit-entitlement-contract.md). |
| **Bundle ID / team / signing** | Need an Apple Developer setup + `waynode` App ID + APNs `.p8` key. **Action for Francesco.** |
| **Do we ship the Mac app to the App Store or notarized direct?** | Default: **notarized, outside the store** (faster iteration, no review for v1). Revisit. |
| **App name / icon / brand** | Need assets. Can run `/ads dna` on waynode.fornace.net for a brand profile, then design. |

---

## 13. What I need from Francesco to start

1. **Greenlight on the architecture** — specifically the call that work is
   server-resident (not on-device) and APNs carries the "it's done" signal.
2. **Apple Developer access** — Team ID, ability to create the App ID +
   APNs auth key (`.p8`).
3. **Preferred bundle id** (e.g. `ai.waynode.app`) + whether Mac goes App Store
   or notarized.
4. **App name + icon direction** (or OK to draft a brand via `/ads dna`).
5. **OK to build the 3 server additions** (tokens, devices, APNs) behind env
   flags in the `waynode` repo first — that's Phase 0 and unblocks everything.

---

### TL;DR

The "continue when killed" requirement is already 90% solved by the existing
server (server-resident agent + disk-persisted JSONL). The real work is
**(1) bearer-token auth, (2) APNs milestone pushes, (3) a beautiful native
SwiftUI/TCA client.** ~3–4 weeks to TestFlight. Phase 0 (server plumbing) is
small, safe, and unblocks the rest. Say the word and I'll start Phase 0.
