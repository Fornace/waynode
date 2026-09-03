# Resilient session defect archive

Date: 2026-08-29
Author: Waynode maintainers

This archive preserves the pre-implementation defect evidence that informed
[`RESILIENT-SESSIONS.md`](./RESILIENT-SESSIONS.md). The active runtime contract
and implementation state live in that primary document. External architecture
research and receipts live in
[`RESILIENT-SESSIONS-RESEARCH.md`](./RESILIENT-SESSIONS-RESEARCH.md).

## Confirmed defects

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
