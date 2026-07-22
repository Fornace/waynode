import { useRef, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import type { ComposerMode } from "../types";
import { isTouchDevice } from "../utils/device";

interface ChatComposerProps {
  input: string;
  mode: ComposerMode;
  streaming: boolean;
  uploading: boolean;
  hammersmithState: "checking" | "ready" | "setup" | "unavailable" | "unsupported";
  inputRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onInput: (value: string) => void;
  onAutosize: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onInsertNewline: () => void;
  onAbort: () => void;
  onQueue: () => void;
  onModeChange: (mode: ComposerMode) => void;
  onSend: (mode: ComposerMode) => void;
}

const MODES: Array<{ mode: ComposerMode; label: string; hint: string; action: string }> = [
  { mode: "message", label: "Message", hint: "Chat with the agent in this session.", action: "Send" },
  { mode: "goal", label: "Goal", hint: "Let Pi work autonomously until complete or blocked.", action: "Start goal" },
  { mode: "hammersmith", label: "Hammersmith", hint: "Delegate this job to a verified swarm.", action: "Delegate" },
];
const INPUT_NAMES: Record<ComposerMode, string> = {
  message: "Message the agent",
  goal: "Describe the goal",
  hammersmith: "Describe the Hammersmith job",
};

export function ChatComposer(props: ChatComposerProps) {
  const {
    input, mode, streaming, uploading, hammersmithState, inputRef, fileInputRef,
    onInput, onAutosize, onKeyDown, onFileUpload, onInsertNewline,
    onAbort, onQueue, onModeChange, onSend,
  } = props;
  const radios = useRef<Array<HTMLInputElement | null>>([]);
  const visibleModes = MODES.filter((item) => item.mode !== "hammersmith" || hammersmithState !== "unsupported");
  const selected = MODES.find((item) => item.mode === mode) || MODES[0];
  const hammersmithDisabled = hammersmithState !== "ready";
  const focusMode = mode === "hammersmith" && hammersmithDisabled ? "message" : mode;

  const moveRadio = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const enabled = visibleModes.filter((item) => item.mode !== "hammersmith" || !hammersmithDisabled);
    const current = Math.max(0, enabled.findIndex((item) => item.mode === mode));
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const next = enabled[(current + step + enabled.length) % enabled.length];
    onModeChange(next.mode);
    const index = visibleModes.findIndex((item) => item.mode === next.mode);
    requestAnimationFrame(() => radios.current[index]?.focus());
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        <input type="file" multiple ref={fileInputRef} onChange={onFileUpload} hidden />
        <div className={`composer-modes ${visibleModes.length === 2 ? "two-modes" : ""}`} role="radiogroup" aria-label="Send mode" aria-describedby="composer-selected-hint" onKeyDown={moveRadio}>
          {visibleModes.map((item, index) => {
            const disabled = streaming || (item.mode === "hammersmith" && hammersmithDisabled);
            return (
              <label key={item.mode} className={`composer-segment ${mode === item.mode ? "selected" : ""} ${disabled ? "disabled" : ""}`}>
                <input
                  ref={(element) => { radios.current[index] = element; }}
                  type="radio" name="composer-mode" value={item.mode}
                  checked={mode === item.mode} disabled={disabled}
                  tabIndex={focusMode === item.mode ? 0 : -1}
                  onChange={() => onModeChange(item.mode)}
                />
                <ModeIcon mode={item.mode} /><span>{item.label}</span>
              </label>
            );
          })}
        </div>
        <textarea
          ref={inputRef}
          className="composer-input"
          placeholder={streaming ? "Add a follow-up…" : mode === "goal" ? "Describe the goal…" : mode === "hammersmith" ? "Describe the job for the swarm…" : "Message the agent…"}
          value={input}
          onChange={(event) => { onInput(event.target.value); onAutosize(); }}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label={INPUT_NAMES[mode]}
          aria-describedby="composer-selected-hint"
        />
        <p className="composer-mode-note" id="composer-selected-hint">
          {selected.hint}
          {hammersmithState === "checking" && " Checking Hammersmith…"}
          {hammersmithState === "setup" && " Set up Hammersmith in Account settings."}
          {hammersmithState === "unavailable" && " Hammersmith is temporarily unavailable; check again in Account settings."}
        </p>
        <div className="composer-rail">
          <div className="composer-tools">
            <button className="attach-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading || streaming} aria-label="Attach files" title="Attach files">
              {uploading ? <LoadingIcon /> : <AttachmentIcon />}
            </button>
          </div>
          <div className="send-group">
            {isTouchDevice() && !streaming && <button className="newline-btn" onClick={onInsertNewline} aria-label="Insert new line" title="Insert new line"><NewlineIcon /></button>}
            {streaming ? <>
              <button className="queue-btn" onClick={onQueue} disabled={!input.trim()} aria-label="Queue follow-up">Queue</button>
              <button className="send-btn send-stop" onClick={onAbort} aria-label="Stop agent" title="Stop agent"><StopIcon /></button>
            </> : (
              <button className="send-btn" onClick={() => onSend(mode)} disabled={!input.trim() || (mode === "hammersmith" && hammersmithDisabled)} aria-label={selected.action} title={selected.action}>
                <span>{selected.action}</span><SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeIcon({ mode }: { mode: ComposerMode }) {
  if (mode === "message") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14v9H8l-4 3v-3H3z" /></svg>;
  if (mode === "goal") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3" /></svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="2" /><circle cx="10" cy="4" r="2" /><circle cx="16" cy="10" r="2" /><path d="M6 9l3-4m2 0 3 4M6 11l8 0" /></svg>;
}
function SendIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>; }
function StopIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>; }
function NewlineIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" /></svg>; }
function AttachmentIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M21.4 11l-9.2 9.2a6 6 0 01-8.4-8.4L13 2.6a4 4 0 015.6 5.6l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5" /></svg>; }
function LoadingIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="spin" aria-hidden="true"><path d="M21 12a9 9 0 11-6.2-8.6" /></svg>; }
