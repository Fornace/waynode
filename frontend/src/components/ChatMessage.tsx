import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ChatItem, Block } from "../types";

// ── Message rendering ──

export function MessageRow({ item, streaming }: { item: ChatItem; streaming: boolean }) {
  if (item.role === "system") {
    return (
      <div className="msg msg-system">
        <div className="msg-bubble msg-bubble-system">{item.content}</div>
      </div>
    );
  }

  if (item.role === "user") {
    // Parse out [Uploaded files: ...] for nice UI rendering
    const parts = item.content.split(/(\[Uploaded files?: .*?\])/g);

    return (
      <div className="msg msg-user">
        <div className="msg-bubble msg-bubble-user">
          {item.isGoal && <span className="msg-tag">🎯 Goal</span>}
          {parts.map((part, i) => {
            if (part.startsWith("[Uploaded file")) {
              const match = part.match(/\[Uploaded files?: (.*?)\]/);
              if (match) {
                const files = match[1].split(",").map(f => f.trim());
                return (
                  <div key={i} className="msg-attachments">
                    {files.map((f, j) => (
                      <span key={j} className="msg-attachment-pill">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                        {f}
                      </span>
                    ))}
                  </div>
                );
              }
            }
            return <span key={i}>{part}</span>;
          })}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg msg-assistant">
      <div className="msg-avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
      </div>
      <div className="msg-body">
        {item.blocks.map((b, i) => (
          <BlockView key={i} block={b} streaming={streaming} isLastBlock={i === item.blocks.length - 1} />
        ))}
        {streaming && item.blocks.length === 0 && (
          <div className="msg-typing"><span /><span /><span /></div>
        )}
      </div>
    </div>
  );
}

function BlockView({
  block,
  streaming,
  isLastBlock,
}: {
  block: Block;
  streaming: boolean;
  isLastBlock: boolean;
}) {
  if (block.type === "text") {
    const showCursor = streaming && isLastBlock;
    return (
      <div className="msg-text">
        <ReactMarkdown>{block.text || ""}</ReactMarkdown>
        {showCursor && <span className="stream-cursor" />}
      </div>
    );
  }

  if (block.type === "thinking") {
    return (
      <details className="msg-thinking">
        <summary>💭 Reasoning</summary>
        <div className="msg-thinking-body">{block.text}</div>
      </details>
    );
  }

  // tool
  return <ToolCard block={block} />;
}

function ToolCard({ block }: { block: Extract<Block, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const arg = block.args;
  const preview =
    block.name === "bash" || block.name === "ctx_shell" || block.name === "shell"
      ? arg?.command
      : block.name === "edit" || block.name === "ctx_edit"
      ? arg?.path || arg?.file
      : block.name === "read" || block.name === "ctx_read"
      ? arg?.path
      : block.name === "write"
      ? arg?.path
      : JSON.stringify(arg)?.slice(0, 80);

  const statusIcon =
    block.status === "running" ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    ) : block.status === "error" ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
    );

  return (
    <div className={`tool-card tool-${block.status}`} onClick={() => setOpen((v) => !v)}>
      <div className="tool-card-head">
        <span className="tool-icon">{statusIcon}</span>
        <span className="tool-name">{block.name}</span>
        {preview && <span className="tool-preview">{preview}</span>}
      </div>
      {open && block.output && (
        <pre className="tool-output">{block.output}</pre>
      )}
    </div>
  );
}
