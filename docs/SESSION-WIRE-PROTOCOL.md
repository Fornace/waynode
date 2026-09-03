# Session wire protocol v2

Version: 2. Reviewed 2026-08-29.
Source of truth: pi session JSONL (`<space>/.waynode/sessions/<sessionId>`).

## Guarantees

1. A client opening or reconnecting to a session receives the exact durable
   transcript plus at most one in-flight live overlay.
2. Every durable transcript item has pi's stable entry id. The id is a replay
   cursor and is emitted as the SSE `id:` value.
3. Durable entry batches are idempotent. Clients merge them by `entry.id`.
4. A live assistant overlay is ephemeral. The next durable assistant entry
   supersedes it; clients never display both.
5. Browser disconnect never controls agent lifetime. A server restart marks
   active submission rows interrupted and automatically resumes them.
6. Pi `agent_settled` is the authoritative turn-completion event. Earlier
   `agent_end` events can still be followed by retries, compaction recovery,
   or queued follow-ups.
7. An assistant tool call is never blindly replayed after execution stops.
   Waynode restores a durably journaled final result, or appends an error
   result that says execution and side effects are uncertain, before Pi can
   continue the session.

## Opening the stream

```http
GET /api/sessions/:sessionId/stream?since=<entryId>
Accept: text/event-stream
Last-Event-ID: <entryId>
```

`Last-Event-ID` wins over `?since`. EventSource sends it automatically on a
network reconnect; `?since` exists for native clients and explicit reloads.
Reading a stream never starts an agent. The session bus attaches the open
stream to a later `POST /message` agent spawn.

First frames:

```text
data: {"type":"connecting"}

id: a1b2c3d4
data: {"type":"sync", ...}
```

## `sync`

```json
{
  "type": "sync",
  "fromStart": true,
  "cursor": null,
  "entries": [],
  "leafId": "a1b2c3d4",
  "streaming": true,
  "live": {
    "messageId": "transient-message-id",
    "text": "partial assistant text",
    "thinking": "partial reasoning",
    "tools": []
  },
  "submissions": [],
  "interrupted": []
}
```

- `fromStart=true`: `entries` is the complete durable active branch; replace
  local durable items (then add `live`). Also true when the cursor is unknown.
- `fromStart=false`: `entries` contains only items after the cursor; merge.
- `live`: the ONE assistant message currently streaming. It is per-message,
  never accumulated across a multi-message agentic turn.
- `items`, `partialText`, and `tools` are legacy native-client mirrors.

## Durable entry union

Common fields: `id`, `parentId`, `timestamp`, `role`.

```json
{"id":"u1","parentId":null,"timestamp":"...","role":"user","text":"hello","submissionId":"uuid"}
{"id":"a1","parentId":"u1","timestamp":"...","role":"assistant","blocks":[
  {"type":"thinking","text":"..."},
  {"type":"toolCall","id":"call_1","name":"bash","args":{"command":"pwd"}},
  {"type":"text","text":"Done."}
]}
{"id":"t1","parentId":"a1","timestamp":"...","role":"toolResult","toolCallId":"call_1","toolName":"bash","isError":false,"text":"/workspace\n"}
{"id":"c1","parentId":"t1","timestamp":"...","role":"note","kind":"compaction","text":"Earlier work ..."}
```

A `toolResult` patches the newest assistant tool block with the same
`toolCallId`. It does not become a separate chat bubble.

## Live events

- `start`, `turn_start`, `message_start {messageId}`
- `thinking_delta {messageId, delta}`
- `text_delta {messageId, delta}`
- `tool_start`, `tool_delta`, `tool_end`
- `message_end`
- `entries {entries, leafId}`: newly durable items; SSE id is `leafId`
- `status {text}`: retry, compaction, other honest progress
- `submission {submission}`: durable user-facing lifecycle state
- `queue {queued}`: pi's queue count
- `end`: pi emitted `agent_settled`
- `resumed`: restart recovery dispatched the interrupted turn
- `error`: execution stopped unexpectedly; transcript remains durable
- `ping`: keepalive, no state change

## Submission lifecycle

```text
sending (client only)
  -> starting -> running -> completed
              -> queued -> running -> completed
  -> failed | cancelled | interrupted
```

Submission rows live in SQLite. On process boot, stale `queued`, `starting`,
or `running` rows become `interrupted`, then recovery continuation dispatches
the oldest turn with its original submission id. Before Pi starts, Waynode
repairs every unmatched tool call on the active JSONL branch. A finalized
result captured by the reviewed `waynode-tool-journal` extension is restored
with the original `toolCallId`; the sidecar uses Pi's stable session id rather
than a substrate-specific absolute path, so `/workspace/...` in a microVM and
the corresponding host path resolve to the same identity. A call without such
a result receives an
`isError: true` result explaining that execution and side effects are
uncertain. Pi then sees each previous tool call as resolved and cannot execute
it merely because the server restarted. Remaining submission rows go back
into Pi's follow-up queue. A manual `POST /api/sessions/:id/resume` is
available if a boot-time start failed.

## Restart and deploy behavior

SIGTERM sets drain mode: new turns receive 503 with a restart explanation;
running turns get 90 seconds to settle (`WAYNODE_DRAIN_MS`). Docker grants a
2-minute stop grace. Anything still in flight becomes recoverable at the next boot. Pi
`--continue` supplies the original user message and any durable partial
output. Unmatched tool calls are resolved first under the no-blind-replay rule
above, then the internal recovery prompt tells the model to continue without
repeating visible work. The original user prompt remains the submission truth.

## Client merge rules

1. Apply full sync: clear durable items, merge entries by id, append `live`.
2. Apply cursor sync: merge entries by id, preserve existing items, append or
   update `live`.
3. Apply `entries`: patch tool results, add unseen ids, replace ended overlay
   when the batch contains its durable assistant entry.
4. A persisted user entry with `submissionId` swaps the optimistic bubble to
   the stable entry id while preserving raw display prompt, mode, and status.
5. When `end` arrives, mark any remaining overlay done. The final `entries`
   batch is authoritative.
