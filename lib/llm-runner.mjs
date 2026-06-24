import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, streamText } from "ai";
import { config } from "./config.mjs";
import db from "./db.mjs";

export function llmModel(modelOverride) {
  const provider = createOpenAI({
    apiKey: config.llm.apiKey,
    baseURL: `${config.llm.baseUrl.replace(/\/$/, "")}/v1`,
  });
  return provider.chat(modelOverride || config.llm.model);
}

export function isLLMConfigured() {
  return !!(config.llm.baseUrl && config.llm.apiKey);
}

export async function createChatStream({ session, prompt, abortSignal, onFinish }) {
  const priorMessages = db.prepare(`
    SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC
  `).all(session.id).map((m) => ({
    id: `m-${m.id}`,
    role: m.role,
    parts: [{ type: "text", text: m.content }],
  }));

  priorMessages.push({
    id: `m-new`,
    role: "user",
    parts: [{ type: "text", text: prompt }],
  });

  const modelMessages = await convertToModelMessages(
    priorMessages.map(({ id: _id, ...msg }) => msg),
    { ignoreIncompleteToolCalls: true }
  );

  const result = streamText({
    model: llmModel(session.model),
    messages: modelMessages,
    abortSignal,
    maxRetries: 2,
  });

  return result.toUIMessageStream({
    originalMessages: priorMessages,
    sendReasoning: true,
    onError: (error) => {
      console.error("[ai-sdk] stream error:", error);
      return error instanceof Error ? error.message : "Chat failed";
    },
    onFinish,
  });
}
