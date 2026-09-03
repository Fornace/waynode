# Resilient Agent Sessions: Analysis and Plan

Date: 2026-08-29. Research reviewed 2026-08-28/29 against live docs.
Scope: why waynode sessions feel frail (close/reopen out of sync, doubt about
unattended work, duplicated first-stream vs reload code), what the strongest
platforms do, and a concrete plan to make sessions feel SOLID.

---

## 1. Executive summary

Waynode's chat architecture is one honest SSE design away from solid. The
server already runs agents independently of browser connections (good), and
pi already persists a durable, cursor-addressable event log per session
(unknown to most of our code). The frailty comes from four root causes:

1. **Two representations of a conversation.** Live streaming renders rich
   blocks (thinking, text, tools); reload renders a lossy flat text list
   parsed from disk that drops tool calls and tool results entirely. Clients
   glue the two with heuristics. Reload literally shows a different, poorer
   conversation.
2. **No event replay.** SSE has no Last-Event-ID. A client that misses events
   (network blip, tab switch, second device) gets only an in-memory
   `sync` snapshot: accumulated text of the whole turn (wrongly spliced) and
   no tool activity. Missed events are gone forever.
3. **No durability across server restarts.** Deploys force-recreate the
   container and SIGKILL every pi process mid-turn. Nothing detects the
   interrupted turn, nothing resumes it. Long goal runs are the worst hit.
   This justifies the "I doubt it keeps working when I'm not looking" feeling:
   sometimes it genuinely does not.
4. **Duplicated state machines.** Waynode re-implements pi's follow-up queue,
   turn lifecycle (`agent_end` vs pi's real settle signal), submission
   tracking, and the whole client-side event reducer exists twice more (web
   TS, native Swift) plus once server-side. Each duplicate is a desync
   opportunity.

The fix is not new infrastructure. It is to make pi's own session JSONL the
durable source of truth (it is an append-only tree with stable entry ids and
an RPC cursor API), serve replay from it, render ONE message model everywhere,
let pi own the queue, and add a recovery-continuation path so a restarted
server resumes interrupted turns. Trigger.dev's GA Sessions product is the
blueprint; their full pattern maps onto pieces waynode already has.

---

## 2. How sessions work today (evidence map)

```
Browser A ──POST /message────────────┐
Browser A ──GET /stream (SSE)────────┤
Browser B ──GET /stream (SSE)────────┤   routes/sessions.js
                                     │
                    getAgent(session) │ lib/agent-manager.mjs
                      AgentHandle ───┤ lib/agent-rpc-handle.mjs
                        pi --mode rpc│   (long-lived subprocess)
                          │ writes   │
                          ▼          │
              <space>/.waynode/sessions/<id>/*.jsonl   (pi session log)
                                     │
Browser A ──GET /messages ◄──────────┘ lib/sessions.mjs getMessagesFromDisk()
             (lossy flat projection, re-read on every load)
```

Key files: routes/sessions.js (SSE + send/queue), lib/agent-manager.mjs
(process ownership, 30-min idle reaper), lib/agent-rpc-handle.mjs (pi RPC
wrapper with own queue + ledger), lib/sandboxed-agent-handle.mjs (hosted
one-shot-per-turn twin), lib/agent-rpc-events.mjs (event translation),
lib/sessions.mjs getMessagesFromDisk (lossy disk history),
frontend/src/lib/sessionStore.ts + sessionTransport/sessionSubmissions/
sessionBlocks (web store), native-app/WaynodeCore (third client in Swift),
.github/deploy/deploy-production.sh (docker stop -t 30 + force-recreate).

What already works well (keep): server-owned agents detached from HTTP
clients; idempotent submissionIds; pi session files inside the space worktree;
goal status read from disk; sandboxed path already has run-per-turn shape.

---

## 3. Original defect inventory

The original file-level evidence is archived in
[`RESILIENT-SESSIONS-DEFECTS.md`](./RESILIENT-SESSIONS-DEFECTS.md), and the
external architecture comparison is archived in
[`RESILIENT-SESSIONS-RESEARCH.md`](./RESILIENT-SESSIONS-RESEARCH.md). The ten
confirmed defects covered lossy reloads, reconnect text splicing, no cursor
replay, restart data loss, duplicated Pi lifecycle and queue state, volatile
submissions, read-triggered agent boots, divergent client reducers, coarse
hosted streaming, and hosted production exposure. Sections below define the
implemented target and current durability contract.

## 5. Gap analysis: what "SOLID" requires vs today

SOLID bar (from trigger.dev/CF/Happy behavior):
1. Send a message → it is durable before generation starts.
2. Reload/close/reopen on any device → identical conversation at full
   fidelity, and an in-flight turn resumes streaming where it is.
3. Server restart/deploy → work pauses and resumes (or cleanly reports),
   never silently vanishes.
4. Idle hours → nothing runs, nothing lost; next message is instant.
5. **One wire contract, rendered identically everywhere.**
6. **Crash-safe tool boundary.** A process death between an external tool's
   side effect and Pi's normal `toolResult` append can never cause automatic
   re-execution or false success. Waynode fsyncs finalized results in a
   reviewed Pi extension. Recovery appends that exact result when present,
   otherwise a Pi-native error result says execution and side effects are
   uncertain. Only then may continuation begin.

| Bar | Today |
|---|---|
| 1 | pi persists the user entry on accept; OK (verify in tests) |
| 2 | fails: D1 lossy disk projection, D2/D3 no replay, four renderings |
| 3 | fails: D4 no drain/recovery; deploys kill runs |
| 4 | partial: idle reaper kills silently; reading boots agents (D7) |
| 5 | fails: D5/D8 duplicated state machines |

---

## 6. Target architecture: pi-native durable sessions

Principle: **pi's session JSONL is the session.** Waynode adds: a cursor
protocol over it, one canonical projection, pi-owned queue semantics,
persistent session state, and recovery continuation. No new infrastructure.

### 6.1 One message model + one projection
Replace `getMessagesFromDisk` with a full-fidelity projection of pi entries:
user, assistant (text/thinking/toolCall blocks), toolResult, bashExecution,
compaction markers; per-item stable id = pi entry id; ordered by the active
branch (follow parentId to leafId; ignore abandoned branches). Server tests
pin JSON fixtures → projection. Both clients render THIS shape; live deltas
update items by pi entry/message id. The web `contentKey` dedup heuristic
and the `history-*` transient ids disappear.

### 6.2 Event protocol with replay (waynode SSE v2)
- `GET /api/sessions/:id/stream?since=<entryId>`: serve projection entries
  after `since` from disk, then live events if an agent is running. Live
  events stay as today but persisted boundaries broadcast the entry, so
  clients advance their cursor on message_end, not only on turn end.
- Sync snapshot becomes: full projection (or entries-after-cursor) + `live`
  block = in-flight message partial keyed by messageId + pi queue state
  (`queue_update` mirror) + submission snapshot. Partials reset per
  `message_start`.
- Reading a session never spawns pi (D7): stream serves disk truth; agent
  boots only on send/queue/terminal.

### 6.3 pi owns the queue and the turn lifecycle
Delete `_followUpWaiters`; `/queue` sends pi `follow_up` and `agent_start`s
promote FIFO records. Settle on `agent_settled` (agent_end/willRetry/auto-
retry/compaction are status, not completion). SubmissionLedger persists to
SQLite so state survives restarts and is visible cross-device.

### 6.4 Recovery continuation (the trust fix)
On server boot (and handle spawn), read the projection tail: if the active
branch ends with an unanswered user message AND a submission row says a turn
was in flight, automatically continue it (pi's `--continue` already has the
partial output in context; a continuation instruction finishes the job,
trigger's recovery-boot splice). Surface "Turn resumed after server restart"
in the UI. Pair with deploy-time drain: SIGTERM stops accepting turns, waits
up to N minutes for streaming agents, then dies knowing recovery resumes.

### 6.5 Unify the two handles
Both handles satisfy one surface (subscribe/streaming/submissions/send/
queue/abort/setModel/shutdown) sharing ledger, projection, rename, metering.
The sandbox adapter gains real fidelity by broadcasting the turn's JSONL
entries after each run instead of the whole-text fallback. Longer-term:
in-process `AgentSession` SDK instead of a subprocess.

### 6.6 One contract, three renderers
Write `docs/SESSION-WIRE-PROTOCOL.md` (events + projection schema + cursor
rules) with JSON fixtures under `e2e/fixtures/` used by: server projection
tests, web store tests, native Swift decoder tests. Any client (web, iOS,
future CLI) consumes the same replay stream.

### 6.7 Keep-alive details that sell "seamless"
- SSE `id:` field = last entry id (EventSource auto-sends Last-Event-ID on
  browser reconnect; also accept `?since=`).
- 15s ping stays; add explicit `settled` close so idle reconnects end fast.
- Mobile: keep EventSource auto-reconnect; the store's closeTimer (30s)
  already avoids battery burn; verify page-visibility resume behavior.
- Optional later: Web Push when a goal turn settles while no viewer is
  connected (session_events table gives the hook).

### 6.8 Tool-call recovery boundary

Pi persists an assistant tool call before execution and its `toolResult`
after `tool_execution_end`. A SIGKILL inside that interval otherwise leaves
an unmatched call which Pi may execute again on `--continue`. The
`waynode-tool-journal` extension writes each finalized result to an
fsync-backed, per-JSONL sidecar before Pi's host listener proceeds. The
sidecar stores Pi's stable session id, so hosted `/workspace/...` and host
absolute paths cannot split identity. `message_end` performs no cleanup because
Pi appends JSONL afterward. `agent_settled`, a later cold start, or host repair
consumes only records whose matching JSONL `toolResult` is already durable.
On cold handle creation and boot continuation, the host scans the active branch
before starting Pi:

- a matching sidecar record becomes the exact Pi-native `toolResult`;
- a missing record becomes an `isError: true` result that says execution and
  side effects are uncertain;
- stable `toolCallId` matching and active-branch traversal make repair
  idempotent and avoid touching abandoned branches.

This enforces at-most-once automatic tool execution across server and
microVM crashes. A user or agent can choose a later explicit retry only after
inspecting current state.

---

## 7. Phased plan

Phase 0 (verify, ~half day): pin current behavior with tests that fail for
the right reasons: multi-message turn reconnect splice (D2), reload drops
tools (D1), mid-turn kill loses turn (D4). Use e2e/test-session-stream-
reconnect.mjs harness style + a fixtures corpus from real JSONL.

Phase 1 (projection + cursor reads): full-fidelity projection; `/events?
since=`; stream serves reads without spawning agents; web+native render
projection for history (kills D1, D7; lays base for D3).

Phase 2 (replay + live cursor): SSE v2 with entry cursors, per-message
partials, settled close; single reducer keyed by entry ids on web; native
contract update (kills D2, D3; contentKey heuristics die).

Phase 3 (pi-owned queue + persisted ledger): remove `_followUpWaiters`,
adopt `queue_update`/`agent_settled`, submissions table (kills D5, D6).

Phase 4 (recovery continuation + drain): boot-time interrupted-turn
detection and auto-resume, deploy SIGTERM drain, "resumed" UI affordance
(kills D4; the unattended-trust fix).

Phase 5 (unify handles + sandbox fidelity): shared adapters; sandbox path
emits real tool events from the session JSONL (kills D8, D9).

Phase 6 (optional polish): in-process AgentSession; push notifications on
settle; cross-tab BroadcastChannel. Each phase ships behind the existing e2e
suites; no big-bang rewrite. Phases 1-2 alone change the felt reliability most.

## 8. What we deliberately do not adopt

Self-hosted trigger.dev for the chat loop: the engine needs a pi subprocess
per space worktree, PTY terminals, KVM microsandboxes, and repo-level git
credentials; pi's own log gives the same durability at a fraction of the
operational surface (Hammersmith can revisit it separately). Cloudflare
Agents runtime: same engine mismatch. Patterns adopted, runtimes not.

## 9. Receipts

- trigger.dev llms index + pages (overview, sessions, how-it-works,
  client-protocol, persistence-and-replay, recovery-boot, self-hosting/
  docker), fetched 2026-08-28/29; sdk 4.5.13; GA note v4.5.0 2026-07-02;
  s2-lite bundled self-host.
- Cloudflare Agents docs (index, sessions, state, websockets), updated
  2026-06/08 2026; Session API "inspired by Pi".
- github.com/zirkelc/ai-resumable-stream README (Redis replay pattern).
- github.com/slopus/happy README (daemon + E2E relay multi-device).
- pi 0.84.3 docs: session-format.md, rpc.md (get_entries cursor,
  agent_settled, queue_update, follow_up/steer, AgentSession in-process).
- Waynode sources as cited in section 3; deploy script lines 199/308
  (docker stop -t 30, up -d --force-recreate).
- Prod deployment verified 2026-08-29 via SSH (95.216.37.30): container
  `waynode` healthy, revision 209d8f6, WAYNODE_DEPLOYMENT=hosted, /dev/kvm
  present, no DEV_AUTH_TOKEN in prod env (repo AGENTS.md prod-E2E recipe is
  stale; e2e/README.md correctly says prod uses real OAuth only), zero pi
  processes idle.
