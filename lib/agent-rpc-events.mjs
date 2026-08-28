import { projectAfter } from "./pi-session-projection.mjs";

export function createRequestId() {
  return Math.random().toString(36).slice(2, 10);
}

function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = result.content || result.partialResult?.content || [];
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && (item.type === "text" || !item.type))
      .map((item) => item.text || "")
      .join("");
  }
  return result.output || "";
}

/**
 * Translate pi's RPC events into Waynode's stable SSE event contract.
 *
 * Turn lifecycle truth comes from pi: `agent_end` may be followed by retry,
 * compaction, or queued follow-up continuations, so turn completion is
 * `agent_settled`. Persisted boundaries (message_end) trigger an entries
 * broadcast so every client — connected, reconnecting, or another device —
 * renders the same durable items from the session JSONL.
 */
export function normalizeAgentEvent(handle, event) {
  handle._lastActive = Date.now();
  switch (event.type) {
    case "agent_start":
      handle.streaming = true;
      handle.liveTools = [];
      handle._messageEnded = false;
      handle.broadcast({ type: "start" });
      if (handle.currentSubmission && handle.currentSubmission.status !== "running") {
        handle.submissions.update(handle.currentSubmission, "running");
      } else {
        handle._promoteNextQueued();
      }
      return;
    case "turn_start":
      handle.broadcast({ type: "turn_start" });
      return;
    case "message_start": {
      const role = event.message?.role || "assistant";
      if (role === "assistant") {
        // pi messages carry no stable id; generate one per assistant message
        // and reset the per-message partial so reconnect syncs are exact.
        handle.curMsgId = event.message?.id || createRequestId();
        handle.liveText = "";
        handle.liveThinking = "";
        handle._messageEnded = false;
        handle.broadcast({ type: "message_start", messageId: handle.curMsgId });
      }
      return;
    }
    case "message_update": {
      const deltaEvent = event.assistantMessageEvent;
      if (!deltaEvent) return;
      const messageId = handle.curMsgId;
      if (deltaEvent.type === "text_delta") {
        const delta = deltaEvent.delta || "";
        handle.liveText += delta;
        handle.broadcast({ type: "text_delta", messageId, delta });
      } else if (deltaEvent.type === "thinking_delta") {
        const delta = deltaEvent.textDelta || deltaEvent.delta || deltaEvent.reasoningDelta || "";
        handle.liveThinking += delta;
        handle.broadcast({ type: "thinking_delta", messageId, delta });
      }
      return;
    }
    case "message_end": {
      const role = event.message?.role || "assistant";
      if (role === "assistant") handle._messageEnded = true;
      handle.broadcast({ type: "message_end", messageId: event.message?.id || handle.curMsgId });
      // The entry is now durable on disk: broadcast it with its stable id.
      handle._broadcastPersistedEntries();
      return;
    }
    case "tool_execution_start":
      handle.liveTools = [
        ...handle.liveTools,
        { toolCallId: event.toolCallId, name: event.toolName, args: event.args, output: "", state: "running" },
      ];
      handle.broadcast({
        type: "tool_start",
        messageId: handle.curMsgId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return;
    case "tool_execution_update": {
      const text = extractText(event.partialResult);
      handle.liveTools = handle.liveTools.map((tool) =>
        tool.toolCallId === event.toolCallId ? { ...tool, output: text } : tool,
      );
      handle.broadcast({
        type: "tool_delta",
        messageId: handle.curMsgId,
        toolCallId: event.toolCallId,
        text,
      });
      return;
    }
    case "tool_execution_end": {
      const text = extractText(event.result);
      handle.liveTools = handle.liveTools.map((tool) =>
        tool.toolCallId === event.toolCallId
          ? { ...tool, output: text, state: event.isError ? "error" : "done" }
          : tool,
      );
      handle.broadcast({
        type: "tool_end",
        messageId: handle.curMsgId,
        toolCallId: event.toolCallId,
        text,
        isError: !!event.isError,
      });
      return;
    }
    case "turn_end":
      handle.broadcast({ type: "turn_end" });
      return;
    case "agent_end":
      if (event.willRetry) {
        handle.broadcast({ type: "status", text: "Retrying…" });
        return; // settled comes later; never settle on a retry boundary
      }
      handle.broadcast({ type: "status", text: null });
      return;
    case "agent_settled":
      handle._settleTurn();
      return;
    case "queue_update": {
      const pending = (event.followUp?.length || 0) + (event.steering?.length || 0);
      handle._piQueueCount = pending;
      if (pending > 0) handle.streaming = true;
      handle.broadcast({ type: "queue", queued: pending });
      return;
    }
    case "auto_retry_start":
      handle.broadcast({ type: "status", text: `Retrying (${event.attempt}/${event.maxAttempts})…` });
      return;
    case "auto_retry_end":
      handle.broadcast({ type: "status", text: null });
      return;
    case "compaction_start":
      handle.broadcast({ type: "status", text: "Compacting context…" });
      return;
    case "compaction_end":
      handle.broadcast({ type: "status", text: null });
      handle._broadcastPersistedEntries();
      return;
    case "extension_error":
      handle.broadcast({ type: "status", text: `Extension error: ${event.error || ""}` });
      return;
  }
}
