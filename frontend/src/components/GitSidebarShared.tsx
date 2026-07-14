import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Space } from "../types";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

export interface GitIssueAction {
  id: string;
  label: string;
  primary?: boolean;
  run: () => Promise<void>;
}
export interface GitIssue {
  title: string;
  detail: string;
  files?: string[];
  actions: GitIssueAction[];
}

/** Compose the user-visible prompt we send to pi when delegating resolution. */
export function buildAskPrompt(kind: "merge" | "rebase" | "push", ctx: { cur: string; target?: string; files?: string[] }): string {
  const fl = ctx.files && ctx.files.length ? ` — ${ctx.files.join(", ")}` : "";
  if (kind === "merge") {
    return `Resolve the merge of \`${ctx.target}\` into \`${ctx.cur}\`. Run \`git merge ${ctx.target}\`; for any files with \`<<<<<<<\` conflict markers${fl}, resolve them based on both sides' intent, \`git add\` the resolved files, and finish with \`git commit\`. Summarize what you changed; if it isn't safely resolvable, stop and explain.`;
  }
  if (kind === "rebase") {
    return `The branch \`${ctx.cur}\` diverged from its remote. Run \`git pull --rebase\`; for any files with conflict markers${fl}, resolve them, then continue the rebase (\`git rebase --continue\`) per step. If it gets stuck, \`git rebase --abort\` and explain.`;
  }
  return `Push to remote was rejected (the remote has commits you don't). Run \`git pull --rebase\`, resolve any conflicts${fl}, then \`git push\` again. Summarize what happened.`;
}

export const STATUS_COLOR: Record<string, string> = {
  modified: "var(--amber)",
  added: "var(--green)",
  deleted: "var(--red)",
  untracked: "var(--accent)",
  renamed: "#a78bfa",
  copied: "#a78bfa",
  conflict: "var(--red)",
};
// ───────────────────────────── Issue card ─────────────────────────────

export function GitIssueCard({ issue }: { issue: GitIssue }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = async (a: GitIssueAction) => {
    setBusyId(a.id);
    setError("");
    try { await a.run(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The Git action could not be completed."); }
    finally { setBusyId(null); }
  };
  return (
    <div className="git-issue" role="alert">
      <div className="git-issue-title">🔀 {issue.title}</div>
      <div className="git-issue-detail">{issue.detail}</div>
      {issue.files && issue.files.length > 0 && (
        <ul className="git-issue-files">
          {issue.files.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      {error && <div className="git-issue-detail">{error}</div>}
      <div className="git-issue-actions">
        {issue.actions.map((a) => (
          <button
            key={a.id}
            className={a.primary ? "git-btn-primary" : "git-btn-ghost"}
            onClick={() => run(a)}
            disabled={busyId !== null}
          >
            {busyId === a.id ? "…" : a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── Merge picker ─────────────────────────────

export function MergeModal({
  current, branches, busy, onCancel, onPick,
}: {
  current: string;
  branches: { name: string; date: string; remote?: boolean }[];
  busy: boolean;
  onCancel: () => void;
  onPick: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(onCancel, overlayRef);
  const list = branches.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="git-modal-overlay" ref={overlayRef} onClick={onCancel}>
      <div className="git-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="merge-branch-title">
        <div className="git-modal-head">
          <h3 id="merge-branch-title">Merge into {current}</h3>
          <button className="git-icon-btn" onClick={onCancel} aria-label="Cancel branch merge"><CloseIcon /></button>
        </div>
        <div className="git-modal-body">
          <input className="git-input" placeholder="Filter branches…" aria-label="Filter branches to merge" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="git-merge-list">
            {list.length === 0 && <div className="git-empty">No branches.</div>}
            {list.map((b) => (
              <button
                key={b.name}
                className="git-merge-row"
                onClick={() => onPick(b.name)}
                disabled={busy}
              >
                <BranchIcon dim />
                <span className="git-branch-row-name">{b.name}{b.remote && <span className="git-remote-tag">remote</span>}</span>
                <span className="git-branch-row-date">{b.date}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="git-modal-foot">
          <button className="git-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── Diff view ─────────────────────────────

export function FileEditor({ space, path, onClose, onSaved }: { space: Space; path: string; onClose: () => void; onSaved: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [revision, setRevision] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = !loading && content !== original;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api.files.read(space.id, path)
      .then((file) => {
        if (!active) return;
        setContent(file.content);
        setOriginal(file.content);
        setRevision(file.revision);
      })
      .catch((e: Error) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [space.id, path]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !saving && !loading) void save();
      }
    };
    document.addEventListener("keydown", saveShortcut);
    return () => document.removeEventListener("keydown", saveShortcut);
  });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const result = await api.files.write(space.id, path, content, revision);
      setOriginal(content);
      setRevision(result.revision);
      onSaved();
    } catch (e: any) {
      setError(e.message || "Could not save this file");
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (!dirty || window.confirm(`Discard unsaved changes to “${path}”?`)) onClose();
  };
  useEscapeToClose(close, overlayRef);

  return (
    <div ref={overlayRef} className="file-editor-overlay" role="dialog" aria-modal="true" aria-label={`Edit ${path}`} tabIndex={-1}>
      <section className="file-editor">
        <header className="file-editor-head">
          <div className="file-editor-title"><strong>{basename(path)}</strong><span>{dirname(path)}</span>{dirty && <i title="Unsaved changes" />}</div>
          <button className="git-icon-btn" onClick={close} title="Close editor" aria-label={`Close editor for ${path}`}><CloseIcon /></button>
        </header>
        {loading ? <div className="git-empty" role="status">Opening file…</div> : error && !content ? <div className="file-editor-error" role="alert">{error}</div> : <textarea className="file-editor-text" aria-label={`Contents of ${path}`} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} autoFocus />}
        {error && content && <div className="file-editor-error" role="alert">{error}</div>}
        <footer className="file-editor-foot">
          <span>{dirty ? "Unsaved changes" : "Saved"}</span>
          <button className="git-btn-ghost" disabled={!dirty || saving} onClick={() => setContent(original)}>Revert</button>
          <button className="git-btn-primary" disabled={!dirty || saving || loading} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </footer>
      </section>
    </div>
  );
}

export function DiffView({ text }: { text: string }) {
  // Split into lines but keep the trailing newline state stable; React keys
  // by index are fine here since the diff text is immutable for a given expand.
  const lines = text.split("\n");
  return (
    <div className="git-diff-view">
      {lines.map((line, i) => {
        let cls = "diff-context";
        let display = line;
        if (/^(\+\+\+|---|diff |index )/.test(line)) {
          cls = "diff-meta";
        } else if (line.startsWith("@@")) {
          cls = "diff-hunk";
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          cls = "diff-add";
          display = line.slice(1);
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          cls = "diff-del";
          display = line.slice(1);
        }
        return (
          <div key={i} className={`diff-line ${cls}`}>
            <span className="diff-gutter">
              {cls === "diff-add" ? "+" : cls === "diff-del" ? "-" : " "}
            </span>
            <span className="diff-text">{display || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────── bits ─────────────────────────────

export function basename(p: string) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
export function dirname(p: string) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(0, i) : ""; }

export function BranchIcon({ dim }: { dim?: boolean }) {
  return (
    <svg className={`git-branch-ico ${dim ? "dim" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
export function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? "spin" : ""} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
export function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
export function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
export function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
export function Pill({ children }: { children: React.ReactNode }) {
  return <span className="git-pill">{children}</span>;
}
