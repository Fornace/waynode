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

## 3. Defect list (each with symptom and evidence)

### D1. Reload shows a different, poorer conversation
`getMessagesFromDisk` (lib/sessions.mjs) keeps only `user`/`assistant`
messages and only `text`/`thinking` blocks. pi persists much more
(docs/session-format.md): assistant `toolCall` blocks, `toolResult` messages
(both dropped: role filter skips them), bash executions, compaction markers.
Live view: tool chips streaming. Reload: tools vanish, assistant text blobs
merge. Symptom: "open from another browser and they don't seem in sync."
The native app re-derives the same lossy list (server-side endpoint).

### D2. Reconnect sync splices the wrong text
Server: `liveText` resets only on `agent_start` (lib/agent-rpc-events.mjs)
and accumulates across ALL assistant messages of a turn; `liveTools` is
broadcast in `sync` but ignored by both clients. Client merge
(sessionStore.ts `case "sync"`): finds the FIRST not-done assistant bubble
and REPLACES its text block with the whole accumulated `partialText`. In a
multi-message agentic turn the earlier message ends up containing the text of
later messages too (duplication), and tool blocks on reconnect are lost.
`message_end` is never handled, so all bubbles of a turn stay "not done"
until `end`, which is what makes the first-bubble find wrong.

### D3. No event replay, no cursor
`GET /stream` ignores `Last-Event-ID`; every event is broadcast-only.
A client offline for 2 minutes mid-turn loses all tool events and deltas;
the sync snapshot is the only repair and it is partial (D2) and in-memory
only. Second-device mid-turn view: history-with-a-hole plus a weird splice.

### D4. Server restarts and deploys kill work with no recovery
No SIGTERM drain anywhere in server.js; deploy recreates the container.
pi dies mid-turn; the JSONL keeps the trailing user message (pi appends it on
accept) but no assistant reply. On next `getAgent`, pi resumes from the last
complete state: the interrupted turn is silently dropped. The web client has
a partial patch: sync reconciliation marks in-flight submissions failed with
"The server restarted while this message was in flight" (sessionStore.ts),
but that only helps the tab that stays open; disk truth and any other device
just see the unanswered message. Goal mode (50M-token autonomous runs, hours
long) is maximally exposed.

### D5. Duplicated queue + turn lifecycle vs pi
Waynode keeps `_followUpWaiters` (lib/agent-rpc-handle.mjs) AND sends
`follow_up` to pi, which maintains its own queue (rpc.md: follow_up, steer,
`queue_update` events). Turn completion is keyed to `agent_end`, but
`agent_end` "may still be followed by retry, compaction, or queued
continuations"; the real settle signal is `agent_settled` (rpc.md events
table), which waynode does not handle. Consequences: submission ledger can
mark a turn complete while pi auto-retries, promote a follow-up while pi is
still finishing, or show a streaming turn with no current submission after an
unexpected extra agent_start. These are the "sometimes it wedges or lies"
bugs. The code comments in sendPrompt acknowledge the races.

### D6. Volatile session state
Submission ledger, streaming flag, queue: memory only (both handles). A
restart loses "what was in flight" (needed for D4 recovery), and cross-device
clients can only see ACTIVE submissions from the snapshot. Nothing like a
`session_state` row exists.

### D7. Reading a session boots an agent
`GET /stream` calls `getAgent()` unconditionally: merely opening an old
conversation on a cold server spawns a full `pi --mode rpc` process (and
kills the session's terminal PTY via `teardownTerminal`). Reads should be
served from durable state; compute should start on demand.

### D8. Three client implementations, two server handles
The event contract is applied independently in web TS (sessionStore.ts +
2 projection modules), native Swift (SSEClient + Chat + SessionStore), and
server (sync snapshot + getMessagesFromDisk). Server-side, AgentHandle and
SandboxedAgentHandle duplicate: ledger, broadcast/subscribe, sync shape,
abort, rename, metering. This is the "duplicated code between first stream
and reload" concern, and it is real: four renderings of one conversation.

### D9. Hosted sandbox path streams coarse text only
SandboxedAgentHandle emits one synthetic message per turn with plain
`text_delta` chunks (experimental logStream tap, pi-runner.mjs); no thinking,
no tool events, and the final text replaces the stream. Same UI, less truth
than the RPC path.

### D10. Deployment reality makes D9 the only prod experience
Verified on prod 2026-08-29: `WAYNODE_DEPLOYMENT=hosted`, `/dev/kvm`
present, `WAYNODE_SANDBOX_STREAM` unset (config default: off). Every
production chat turn runs the one-shot SandboxedAgentHandle with whole-turn
text and zero incremental events. So on prod today: cross-device mid-turn
view is a spinner until the turn completes, and tool activity is invisible
forever (D1 drops it from history, D9 never streams it). The rich RPC path
only exists on self-hosted deployments.

---

## 4. External research (reviewed 2026-08-28/29)

### 4.1 Trigger.dev Sessions / chat.agent (the direct reference)

Versions (operational receipt):
- npm `@trigger.dev/sdk` latest: **4.5.13** (2026-08-28).
- Sessions/chat.agent/AI Prompts declared **GA in v4.5.0** (2026-07-02,
  changelog).
- Self-host ships **s2-lite** (open-source S2 server) bundled in docker
  compose, so durable session streams need no external service
  (docs/self-hosting/docker).

Architecture (docs/ai-chat/sessions.md, how-it-works.md, client-protocol.md):
- A Session is the durable identity (keyed by caller's externalId) with two
  durable append-only streams: `.in` (user messages) and `.out` (assistant
  chunks). Records have monotonic `seq_num`; readers resume from a cursor.
- Runs are ephemeral compute owned by the session (`currentRunId`). Idle
  runs suspend via full process checkpoint (CRIU today, Firecracker VM
  snapshots in beta); any event restores the exact process.
- **Three persistence layers**, each for a different failure:
  1. engine checkpoint (idle suspend/resume, same process),
  2. per-turn chat snapshot (full message history + out-cursor in object
     storage) for continuation after run exit/crash/deploy,
  3. browser `lastEventId` cursor → `Last-Event-ID` header → SSE replay from
     seq offset for reloads mid-turn.
- **Recovery boot**: next run reads both stream tails; if the previous run
  died mid-answer it splices `[inFlightUser, partialAssistant]` into history
  so a follow-up ("keep going", "actually do X") works with full context.
- Client protocol details worth copying: `turn-complete` control records;
  `.out` trimmed to ~one turn; `X-Peek-Settled`/`X-Session-Settled` fast
  close when reconnecting to an idle chat (avoids 60s long-poll); token
  refresh riding turn-complete headers.
- Failure-mode → layer table from their docs:

| Failure | Trigger layer | Waynode today |
|---|---|---|
| Idle gap mid-conversation | checkpoint resume | process kept alive 30 min, then killed silently |
| Run exited cleanly | chat snapshot + continuation | pi `--continue` chain (works) |
| Run crashed mid-turn | snapshot + `.out` tail replay + recovery boot | turn silently lost |
| Browser reload mid-stream | `lastEventId` SSE replay | lossy sync snapshot (D2/D3) |
| Deploy mid-chat | version upgrade flow, snapshot continuity | container SIGKILL, work lost (D4) |

### 4.2 Cloudflare Agents SDK
Docs (developers.cloudflare.com/agents, updated Jun-Aug 2026): one Durable
Object per agent = durable identity + state + WebSocket hibernation. New
experimental Session API is explicitly "inspired by Pi". Pattern adopted
(identity/state in durable storage, processes replaceable); runtime not
(engine is a pi subprocess with a git worktree and PTY needs).

### 4.3 Vercel AI SDK resumable streams
Canonical community pattern (github.com/zirkelc/ai-resumable-stream; Upstash
blog "Resumable AI SDK v5 Streams with Upstash Realtime"): persist chunks to
a Redis stream keyed by message id; SSE serves with `Last-Event-ID` replay;
stop signals fan out through the same store so any request can abort any
stream. Confirms the shape: chunk log + cursor + cross-request control, i.e.
what S2 gives trigger.dev and what pi's JSONL gives us.

### 4.4 Happy (Claude Code mobile/web client)
github.com/slopus/happy: local daemon owns the session; an E2E-encrypted
relay syncs every client (iOS/Android/web/desktop). The SOLID feeling: one
durable owner, all clients are replaying views, notifications on need.

### 4.5 pi itself (the engine we already run)
Installed 0.84.3 = npm latest. Docs (session-format.md, rpc.md):
- Session JSONL is an append-only tree of entries with stable 8-hex ids;
  assistant messages carry toolCall blocks; toolResult messages carry
  outputs; compaction/branch entries exist. Everything the live UI shows is
  persisted at message granularity.
- RPC `get_entries { since }`: durable cursor ("an entry id works as a
  durable cursor ... even across client restarts"), returns `leafId`.
- RPC events include `agent_settled` (true settle), `queue_update` (pi's own
  queue state), `auto_retry_*`, `compaction_*`.
- `--continue`, `--resume`, `--session-id <id>` (create-if-missing; we
  already use it), `--fork`.
- Node apps can embed `AgentSession` from `@earendil-works/pi-coding-agent`
  in-process instead of spawning `pi --mode rpc` (rpc.md intro). Optional
  future simplification of AgentHandle.

**Conclusion from research:** trigger.dev's durable-session blueprint maps
1:1 onto pi primitives we already have. We need the discipline (one log, one
model, cursors, recovery), not a new platform.

---

## 5. Gap analysis: what "SOLID" requires vs today

SOLID bar (from trigger.dev/CF/Happy behavior):
1. Send a message → it is durable before generation starts.
2. Reload/close/reopen on any device → identical conversation at full
   fidelity, and an in-flight turn resumes streaming where it is.
3. Server restart/deploy → work pauses and resumes (or cleanly reports),
   never silently vanishes.
4. Idle hours → nothing runs, nothing lost; next message is instant.
5. One wire contract, rendered identically everywhere.

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
partial output in context; a continuation instruction finishes the job —
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
