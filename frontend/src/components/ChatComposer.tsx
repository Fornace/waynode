import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import { isTouchDevice } from "../utils/device";

interface ChatComposerProps {
  input: string;
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
  onSend: (isGoal: boolean) => void;
}

export function ChatComposer(props: ChatComposerProps) {
  const {
    input, streaming, uploading, inputRef, fileInputRef,
    onInput, onAutosize, onKeyDown, onFileUpload, onInsertNewline,
    onAbort, onQueue, onSend,
  } = props;

  return (
    <div className="composer">
      <div className="composer-inner">
        <input type="file" multiple ref={fileInputRef} onChange={onFileUpload} hidden />
        <button className="attach-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading || streaming} aria-label="Attach files" title="Attach files">
          {uploading ? <LoadingIcon /> : <AttachmentIcon />}
        </button>
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
        <div className="send-group">
          {isTouchDevice() && !streaming && <button className="newline-btn" onClick={onInsertNewline} aria-label="Insert new line" title="Insert new line"><NewlineIcon /></button>}
          {streaming ? (
            <>
              <button className="queue-btn" onClick={onQueue} disabled={!input.trim()} aria-label="Queue follow-up">Queue</button>
              <button className="send-btn send-stop" onClick={onAbort} aria-label="Stop agent" title="Stop agent"><StopIcon /></button>
            </>
          ) : (
            <>
              <button className="goal-send-btn" onClick={() => onSend(true)} disabled={!input.trim()} aria-label="Send as goal — delegate until complete or blocked" title="Delegate until complete or blocked"><GoalTensionIcon /><span>Goal</span></button>
              <button className="send-btn" onClick={() => onSend(false)} disabled={!input.trim()} aria-label="Send message" title="Send message"><span>Send</span><SendIcon /></button>
            </>
          )}
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
function GoalTensionIcon() {
  return <svg className="goal-tension-icon" viewBox="0 0 24 18" aria-hidden="true">
    <path className="goal-tension-links" d="M4 14L12 4l8 10M4 14h16" />
    <g className="goal-tension-nodes"><circle cx="12" cy="4" r="2.2" /><circle cx="4" cy="14" r="2.2" /><circle cx="20" cy="14" r="2.2" /></g>
  </svg>;
}
