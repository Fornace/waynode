import type { Block } from "../types";

export function appendText(blocks: Block[], text: string): Block[] {
  const out = blocks.slice();
  const last = out[out.length - 1];
  if (last && last.type === "text") out[out.length - 1] = { ...last, text: last.text + text };
  else out.push({ type: "text", text });
  return out;
}

export function appendThinking(blocks: Block[], text: string): Block[] {
  const out = blocks.slice();
  const last = out[out.length - 1];
  if (last && last.type === "thinking") out[out.length - 1] = { ...last, text: last.text + text };
  else out.push({ type: "thinking", text });
  return out;
}

export function appendTool(blocks: Block[], tool: { id: string; name: string; args: any }): Block[] {
  const out = blocks.slice();
  if (!out.some((block) => block.type === "tool" && block.id === tool.id)) {
    out.push({ type: "tool", id: tool.id, name: tool.name, args: tool.args, output: "", status: "running" });
  }
  return out;
}

export function setToolOutput(
  blocks: Block[],
  id: string,
  output: string,
  status: "running" | "done" | "error",
): Block[] {
  return blocks.map((block) =>
    block.type === "tool" && block.id === id ? { ...block, output, status } : block,
  );
}
