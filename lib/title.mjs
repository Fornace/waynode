import { generateText } from "ai";
import { llmModel, isLLMConfigured } from "./llm-runner.mjs";

const SYSTEM =
  "You generate a concise 3-6 word title summarizing a coding conversation. " +
  "Respond with ONLY the title. No quotes, no trailing punctuation, no prefix like 'Title:'.";

/**
 * Generate a short session title from the first user/assistant exchange using a fast model.
 * Returns null on any failure so callers can skip renaming gracefully.
 */
export async function generateTitle(userText, assistantText) {
  if (!isLLMConfigured()) return null;
  try {
    const { text } = await generateText({
      model: llmModel("fornace-fast"),
      system: SYSTEM,
      prompt:
        `User: ${String(userText || "").slice(0, 1200)}\n\n` +
        `Assistant: ${String(assistantText || "").slice(0, 1200)}`,
      maxOutputTokens: 24,
      temperature: 0.3,
    });
    const clean = (text || "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^(title|session)\s*[:\-]\s*/i, "")
      .replace(/[.\s]+$/, "")
      .slice(0, 60);
    return clean || null;
  } catch (err) {
    console.error("[title] generation failed:", err.message);
    return null;
  }
}
