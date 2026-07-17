import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatItem, Block, ToolStatus } from "../types";
import { WaynodeMark } from "./Brand";
import { MarkdownDocument } from "./MarkdownDocument";
import { HammersmithRunWidget } from "./HammersmithRunWidget";

interface MessageRowProps {
  item: ChatItem;
  streaming: boolean;
  phase?: string | null;
  onQuote?: (markdown: string) => void;
}

export function MessageRow({ item, streaming, phase, onQuote }: MessageRowProps) {
  if (item.role === "hammersmith-run") return <HammersmithRunWidget run={item.run} />;
  if (item.role === "system") return <SystemEvent content={item.content} sentAt={item.sentAt} />;

  if (item.role === "user") {
    return (
      <article className="msg msg-user">
        <div className="msg-user-stack">
          <div className="msg-bubble msg-bubble-user">
            {(item.mode === "goal" || item.isGoal) && <span className="msg-tag">Goal</span>}
            {item.mode === "hammersmith" && <span className="msg-tag">Hammersmith</span>}
            {item.submissionStatus && !["completed", "running"].includes(item.submissionStatus) && (
              <span className={`msg-tag submission-${item.submissionStatus}`}>{submissionLabel(item.submissionStatus)}</span>
            )}
            <UserContent content={item.content} />
          </div>
          <MessageTime sentAt={item.sentAt} />
        </div>
      </article>
    );
  }

  return <AssistantTurn item={item} streaming={streaming} phase={phase} onQuote={onQuote} />;
}

function submissionLabel(status: NonNullable<Extract<ChatItem, { role: "user" }>["submissionStatus"]>) {
  return status === "sending" ? "Sending" : status === "queued" ? "Queued"
    : status === "starting" ? "Starting" : status === "failed" ? "Failed"
      : status === "cancelled" ? "Cancelled" : status;
}

function AssistantTurn({
  item,
  streaming,
  phase,
  onQuote,
}: {
  item: Extract<ChatItem, { role: "assistant" }>;
  streaming: boolean;
  phase?: string | null;
  onQuote?: (markdown: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showRaw, setShowRaw] = useState(false);
  const markdown = item.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");

  return (
    <article className="msg msg-assistant" aria-busy={streaming}>
      <header className="assistant-turn-head">
        <span className="assistant-mark"><WaynodeMark size={18} /></span>
        <span>Waynode</span>
        <MessageTime sentAt={item.sentAt} />
        {!streaming && markdown && (
          <TurnActions
            bodyRef={bodyRef}
            markdown={markdown}
            onQuote={onQuote}
            showRaw={showRaw}
            onToggleRaw={() => setShowRaw((value) => !value)}
          />
        )}
      </header>
      <div className="msg-body" ref={bodyRef}>
        {item.blocks.map((block, index) => (
          <BlockView key={index} block={block} streaming={streaming} isLastBlock={index === item.blocks.length - 1} onQuote={onQuote} />
        ))}
        {streaming && item.blocks.length === 0 && <StartingAgent phase={phase} />}
        {showRaw && <pre className="raw-markdown" tabIndex={0}>{markdown}</pre>}
      </div>
    </article>
  );
}

function BlockView({ block, streaming, isLastBlock, onQuote }: { block: Block; streaming: boolean; isLastBlock: boolean; onQuote?: (markdown: string) => void }) {
  if (block.type === "text") {
    return (
      <div className="msg-text">
        <MarkdownDocument>{block.text || ""}</MarkdownDocument>
        {streaming && isLastBlock && <span className="stream-cursor" aria-hidden="true" />}
      </div>
    );
  }

  if (block.type === "thinking") {
    return (
      <details className="trace-disclosure reasoning-disclosure">
        <summary><DisclosureChevron /><span>Reasoning</span><small>Collapsed</small></summary>
        <div className="msg-thinking-body">{block.text}</div>
      </details>
    );
  }

  return <ToolDisclosure block={block} onRecover={onQuote} />;
}

function ToolDisclosure({ block, onRecover }: { block: Extract<Block, { type: "tool" }>; onRecover?: (markdown: string) => void }) {
  const [wrapped, setWrapped] = useState(true);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(block.status === "error");
  const [now, setNow] = useState(Date.now());
  const output = block.output || "";
  const label = TOOL_LABELS[block.name] || "Tool activity";
  const context = toolContext(block);
  let args = "";
  try { args = JSON.stringify(block.args, null, 2); } catch { args = String(block.args ?? ""); }

  useEffect(() => {
    if (block.status === "error") setOpen(true);
  }, [block.status]);

  useEffect(() => {
    if (block.status !== "running" || !block.startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [block.startedAt, block.status]);

  const elapsed = block.startedAt ? formatElapsed((block.endedAt || now) - block.startedAt) : "";

  const copy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <details className={`trace-disclosure tool-${block.status}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <StatusIcon status={block.status} />
        <span>{statusVerb(block.status)} {label.toLowerCase()}</span>
        {context && <small>{context}</small>}
        {elapsed && <time>{elapsed}</time>}
        <DisclosureChevron />
      </summary>
      <div className="tool-details">
        <details className="tool-raw"><summary>Technical details</summary><pre>{block.name}{args ? `\n${args}` : ""}</pre></details>
        {output && <div className={`tool-output-wrap ${wrapped ? "is-wrapped" : ""}`}>
          <div className="tool-output-actions">
            <span>Output</span>
            <button type="button" onClick={() => setWrapped((value) => !value)}>{wrapped ? "No wrap" : "Wrap"}</button>
            <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <pre className="tool-output" tabIndex={0}>{output}</pre>
        </div>}
        {block.status === "error" && onRecover && <button className="tool-recovery" type="button" onClick={() => onRecover(`Recover from the failed ${label.toLowerCase()}.\n\n${output}`)}>Ask agent to recover</button>}
      </div>
    </details>
  );
}

function TurnActions({ bodyRef, markdown, onQuote, showRaw, onToggleRaw }: {
  bodyRef: RefObject<HTMLDivElement | null>;
  markdown: string;
  onQuote?: (markdown: string) => void;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  const [copied, setCopied] = useState("");
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const run = async (label: string, action: () => void | Promise<void>) => {
    await action();
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1400);
    setOpen(false);
  };
  const select = () => {
    if (!bodyRef.current) return;
    const range = document.createRange();
    range.selectNodeContents(bodyRef.current);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); menuRef.current?.querySelector<HTMLElement>("summary")?.focus(); } };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [open]);

  return (
    <details className="turn-actions" ref={menuRef} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label="Answer actions" title="Answer actions">•••</summary>
      <div className="turn-actions-menu">
        <button type="button" onClick={() => run("Copied", () => navigator.clipboard.writeText(bodyRef.current?.innerText || markdown))}>{copied === "Copied" ? "Copied" : "Copy"}</button>
        <button type="button" onClick={() => run("Markdown copied", () => navigator.clipboard.writeText(markdown))}>{copied === "Markdown copied" ? "Markdown copied" : "Copy as Markdown"}</button>
        <button type="button" onClick={() => run("", select)}>Select text</button>
        {onQuote && <button type="button" onClick={() => run("", () => onQuote(markdown))}>Quote in reply</button>}
        <button type="button" onClick={() => run("", onToggleRaw)}>{showRaw ? "Hide raw Markdown" : "View raw Markdown"}</button>
      </div>
    </details>
  );
}

function UserContent({ content }: { content: string }) {
  const marker = content.indexOf("[Uploaded file");
  if (marker < 0) return <>{content}</>;
  const end = content.indexOf("]", marker);
  if (end < 0) return <>{content}</>;
  const prefix = content.slice(0, marker);
  const attachmentText = content.slice(marker + 1, end);
  const separator = attachmentText.indexOf(":");
  const files = separator >= 0 ? attachmentText.slice(separator + 1).split(",").map((file) => file.trim()) : [];
  return <>{prefix}{files.length > 0 && <div className="msg-attachments">{files.map((file) => <span key={file} className="msg-attachment-pill"><AttachmentIcon />{file}</span>)}</div>}</>;
}

function SystemEvent({ content, sentAt }: { content: string; sentAt: string | null }) {
  const event = normalizeSystemEvent(content);
  return <div className={`system-event is-${event.tone}`} role={event.tone === "error" ? "alert" : "status"}><SystemStatusIcon tone={event.tone} /><span>{event.text}</span><MessageTime sentAt={sentAt} /></div>;
}

function MessageTime({ sentAt }: { sentAt: string | null }) {
  if (!sentAt) return <span className="msg-time is-unavailable" title="This saved message predates timestamp support">Time unavailable</span>;
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return <span className="msg-time is-unavailable">Time unavailable</span>;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const label = new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(date);
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);
  return <time className="msg-time" dateTime={date.toISOString()} title={full}>{label}</time>;
}

function normalizeSystemEvent(content: string) {
  const prefixes = [
    { token: "⚠ ", tone: "error" },
    { token: "✗ ", tone: "error" },
    { token: "📝 ", tone: "neutral" },
    { token: "🔀 ", tone: "attention" },
    { token: "✓ ", tone: "success" },
  ];
  const match = prefixes.find(({ token }) => content.startsWith(token));
  return { tone: match?.tone || "neutral", text: match ? content.slice(match.token.length) : content };
}

const TOOL_LABELS: Record<string, string> = {
  bash: "Command",
  shell: "Command",
  ctx_shell: "Command",
  read: "File read",
  ctx_read: "File read",
  edit: "File edit",
  ctx_edit: "File edit",
  write: "File write",
  search: "Code search",
  ctx_search: "Code search",
};

function toolContext(block: Extract<Block, { type: "tool" }>) {
  const args = block.args;
  if (typeof args?.path === "string") return args.path;
  if (typeof args?.file === "string") return args.file;
  return "";
}

function statusVerb(status: ToolStatus) {
  if (status === "running") return "Running";
  if (status === "error") return "Failed";
  return "Completed";
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function StartingAgent({ phase }: { phase?: string | null }) {
  return <div className="agent-starting" role="status"><span className="agent-starting-line" aria-hidden="true" /><span>{phase || "Starting agent…"}</span></div>;
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running") return <span className="status-glyph is-running" aria-hidden="true" />;
  if (status === "error") return <svg className="status-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8m0-8-8 8" /></svg>;
  return <svg className="status-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>;
}

function SystemStatusIcon({ tone }: { tone: string }) {
  if (tone === "error") return <StatusIcon status="error" />;
  if (tone === "success") return <StatusIcon status="done" />;
  return <span className="status-glyph is-event" aria-hidden="true" />;
}

function DisclosureChevron() {
  return <svg className="disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 6l3 3 3-3" /></svg>;
}

function AttachmentIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M21.4 11l-9.2 9.2a6 6 0 01-8.4-8.4L13 2.6a4 4 0 015.6 5.6l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5" /></svg>;
}
