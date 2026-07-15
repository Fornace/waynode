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

/** Translate pi's RPC events into Waynode's stable SSE event contract. */
export function normalizeAgentEvent(handle, event) {
  handle._lastActive = Date.now();
  switch (event.type) {
    case "agent_start":
      handle.streaming = true;
      handle.liveText = "";
      handle.liveTools = [];
      handle.broadcast({ type: "start" });
      handle.submissions?.update(handle.currentSubmission, "running");
      return;
    case "turn_start":
      handle.broadcast({ type: "turn_start" });
      return;
    case "message_start":
      if ((event.message?.role || "assistant") === "assistant") {
        handle.curMsgId = event.message?.id || createRequestId();
        handle.broadcast({ type: "message_start", messageId: handle.curMsgId });
      }
      return;
    case "message_update": {
      const deltaEvent = event.assistantMessageEvent;
      if (!deltaEvent) return;
      const messageId = event.message?.id || handle.curMsgId;
      if (deltaEvent.type === "text_delta") {
        const delta = deltaEvent.delta || "";
        handle.liveText += delta;
        handle.broadcast({ type: "text_delta", messageId, delta });
      } else if (deltaEvent.type === "thinking_delta") {
        const delta = deltaEvent.textDelta || deltaEvent.delta || deltaEvent.reasoningDelta || "";
        handle.broadcast({ type: "thinking_delta", messageId, delta });
      }
      return;
    }
    case "message_end":
      handle.broadcast({ type: "message_end", messageId: event.message?.id });
      return;
    case "tool_execution_start":
      handle.broadcast({
        type: "tool_start",
        messageId: handle.curMsgId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return;
    case "tool_execution_update":
      handle.broadcast({
        type: "tool_delta",
        messageId: handle.curMsgId,
        toolCallId: event.toolCallId,
        text: extractText(event.partialResult),
      });
      return;
    case "tool_execution_end":
      handle.broadcast({
        type: "tool_end",
        messageId: handle.curMsgId,
        toolCallId: event.toolCallId,
        text: extractText(event.result),
        isError: !!event.isError,
      });
      return;
    case "turn_end":
      handle.broadcast({ type: "turn_end" });
      return;
    case "agent_end":
      handle._onAgentEnd();
      return;
    case "auto_retry_start":
      handle.broadcast({ type: "status", text: `Retrying (${event.attempt}/${event.maxAttempts})…` });
      return;
    case "compaction_start":
      handle.broadcast({ type: "status", text: "Compacting context…" });
      return;
    case "extension_error":
      handle.broadcast({ type: "status", text: `Extension error: ${event.error || ""}` });
      return;
  }
}
