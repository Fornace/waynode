# Resilient session architecture research

Date: 2026-08-29
Author: Waynode maintainers

This archive preserves the external architecture comparison that informed
[`RESILIENT-SESSIONS.md`](./RESILIENT-SESSIONS.md). The active runtime contract
and implementation state live in that primary document. Original defect
evidence lives in
[`RESILIENT-SESSIONS-DEFECTS.md`](./RESILIENT-SESSIONS-DEFECTS.md).

## External research (reviewed 2026-08-28/29)

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
