import { useEffect, useRef, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { isTouchDevice } from "../utils/device";

interface ChatComposerProps {
  input: string;
  streaming: boolean;
  uploading: boolean;
  showDropdown: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onInput: (value: string) => void;
  onAutosize: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onInsertNewline: () => void;
  onAbort: () => void;
  onSend: (isGoal: boolean) => void;
  onToggleDropdown: () => void;
}

export function ChatComposer(props: ChatComposerProps) {
  const {
    input, streaming, uploading, showDropdown, inputRef, fileInputRef,
    onInput, onAutosize, onKeyDown, onFileUpload, onInsertNewline,
    onAbort, onSend, onToggleDropdown,
  } = props;
  const composerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!showDropdown) return;
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    const closeOutside = (event: MouseEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) onToggleDropdown();
    };
    const closeEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onToggleDropdown();
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [onToggleDropdown, showDropdown]);

  return (
    <div className="composer">
      <div className="composer-inner" ref={composerRef}>
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
            <button className="send-btn send-stop" onClick={onAbort} aria-label="Stop agent" title="Stop agent"><StopIcon /></button>
          ) : (
            <>
              <div className="send-split">
                <button className="send-btn" onClick={() => onSend(false)} disabled={!input.trim()} aria-label="Send message" title="Send message"><SendIcon /></button>
                <button ref={triggerRef} className="send-caret" onClick={onToggleDropdown} aria-label="More send options" aria-expanded={showDropdown} aria-haspopup="menu" aria-controls="send-options-menu" title="More send options"><ChevronIcon /></button>
              </div>
              {showDropdown && (
                <div className="send-menu" ref={menuRef} id="send-options-menu" role="menu" aria-label="Send options">
                  <button className="send-menu-item" onClick={() => onSend(false)} role="menuitem"><span className="send-menu-label">Send</span><span className="send-menu-desc">Continue this session</span></button>
                  <button className="send-menu-item goal" onClick={() => onSend(true)} role="menuitem"><span className="send-menu-label">Send as goal</span><span className="send-menu-desc">Delegate until complete or blocked</span></button>
                </div>
              )}
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
function ChevronIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>; }
function AttachmentIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M21.4 11l-9.2 9.2a6 6 0 01-8.4-8.4L13 2.6a4 4 0 015.6 5.6l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5" /></svg>; }
function LoadingIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="spin" aria-hidden="true"><path d="M21 12a9 9 0 11-6.2-8.6" /></svg>; }
