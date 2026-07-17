import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import { isTouchDevice } from "../utils/device";

interface ChatComposerProps {
  input: string;
  mode: ComposerMode;
  streaming: boolean;
  uploading: boolean;
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
  onSend: (isGoal: boolean) => void;
}

export type ComposerMode = "message" | "goal";

export function ChatComposer(props: ChatComposerProps) {
  const {
    input, mode, streaming, uploading, inputRef, fileInputRef,
    onInput, onAutosize, onKeyDown, onFileUpload, onInsertNewline,
    onAbort, onQueue, onModeChange, onSend,
  } = props;

  return (
    <div className="composer">
      <div className="composer-inner">
        <input type="file" multiple ref={fileInputRef} onChange={onFileUpload} hidden />
        <textarea
          ref={inputRef}
          className="composer-input"
          placeholder={streaming ? "Add a follow-up…" : "Direct the agent…"}
          value={input}
          onChange={(event) => { onInput(event.target.value); onAutosize(); }}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label="Message the agent"
        />
        {mode === "goal" && !streaming && (
          <p className="composer-mode-note" id="goal-mode-description" role="status">
            Goal mode keeps working until complete or blocked.
          </p>
        )}
        <div className="composer-rail">
          <div className="composer-tools">
            <button className="attach-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading || streaming} aria-label="Attach files" title="Attach files">
              {uploading ? <LoadingIcon /> : <AttachmentIcon />}
            </button>
            {!streaming && (
              <label className="composer-mode">
                <span>Mode</span>
                <select value={mode} onChange={(event) => onModeChange(event.target.value as ComposerMode)} aria-describedby={mode === "goal" ? "goal-mode-description" : undefined}>
                  <option value="message">Message</option>
                  <option value="goal">Goal</option>
                </select>
              </label>
            )}
          </div>
          <div className="send-group">
            {isTouchDevice() && !streaming && <button className="newline-btn" onClick={onInsertNewline} aria-label="Insert new line" title="Insert new line"><NewlineIcon /></button>}
            {streaming ? (
              <>
                <button className="queue-btn" onClick={onQueue} disabled={!input.trim()} aria-label="Queue follow-up">Queue</button>
                <button className="send-btn send-stop" onClick={onAbort} aria-label="Stop agent" title="Stop agent"><StopIcon /></button>
              </>
            ) : (
              <button className="send-btn" onClick={() => onSend(mode === "goal")} disabled={!input.trim()} aria-label={mode === "goal" ? "Send as goal" : "Send message"} title={mode === "goal" ? "Send as goal" : "Send message"}>
                <span>Send</span><SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SendIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>; }
function StopIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>; }
function NewlineIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" /></svg>; }
function AttachmentIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M21.4 11l-9.2 9.2a6 6 0 01-8.4-8.4L13 2.6a4 4 0 015.6 5.6l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5" /></svg>; }
function LoadingIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="spin" aria-hidden="true"><path d="M21 12a9 9 0 11-6.2-8.6" /></svg>; }
