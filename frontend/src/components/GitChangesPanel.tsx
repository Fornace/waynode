import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import type { Space, GitSnapshot } from "../types";
import { STATUS_COLOR, buildAskPrompt, basename, dirname, CheckIcon, CloseIcon, DiffView, FileEditor, Pill, WarnIcon, type GitIssue } from "./GitSidebarShared";

// ───────────────────────────── Changes ─────────────────────────────

export function ChangesPanel({ space, sessionId, snap, onChange, onClose, onIssue }: { space: Space; sessionId: string; snap: GitSnapshot; onChange: (s: GitSnapshot) => void; onClose: () => void; onIssue: (i: GitIssue | null) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Success messages auto-dismiss after a few seconds; errors stick around
  // until the user dismisses them or triggers another action.
  const showMsg = (text: string, kind: "success" | "error") => {
    if (msgTimerRef.current) { clearTimeout(msgTimerRef.current); msgTimerRef.current = null; }
    setMsg({ text, kind });
    if (kind === "success") {
      msgTimerRef.current = setTimeout(() => setMsg(null), 3500);
    }
  };

  useEffect(() => {
    return () => { if (msgTimerRef.current) clearTimeout(msgTimerRef.current); };
  }, []);

  // Keep selection valid as the file list changes
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set(snap.files.map((f) => f.path));
      const next = new Set([...prev].filter((p) => valid.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [snap.files]);

  const allSelected = snap.files.length > 0 && selected.size === snap.files.length;
  const toggle = (path: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(snap.files.map((f) => f.path)));

  const loadDiff = async (path: string) => {
    if (expanded === path) { setExpanded(null); return; }
    setExpanded(path);
    setLoadingDiff(true);
    setDiff("");
    try {
      const { diff } = await api.git.diff(space.id, path);
      setDiff(diff || "(no textual diff — binary or untracked)");
    } catch (e: any) {
      setDiff(`Error: ${e.message}`);
    } finally {
      setLoadingDiff(false);
    }
  };

  const openEditor = (path: string, status: string) => {
    if (status === "deleted") {
      showMsg("This file was deleted. Use the diff to review it, then restore it with git if needed.", "error");
      return;
    }
    setEditorPath(path);
  };

  const handleCommit = async () => {
    if (!summary.trim() || selected.size === 0) return;
    setCommitting(true);
    setMsg(null);
    try {
      const { data } = await api.git.commit(space.id, {
        files: [...selected],
        summary: summary.trim(),
        description: description.trim() || undefined,
      });
      onChange(data);
      setSummary("");
      setDescription("");
      setSelected(new Set());
      setExpanded(null);
      showMsg(`Committed ${selected.size} file${selected.size > 1 ? "s" : ""} to ${snap.currentBranch}`, "success");
    } catch (e: any) {
      showMsg(e.message, "error");
    } finally {
      setCommitting(false);
    }
  };

  const handlePull = async () => {
    setPulling(true);
    setMsg(null);
    try {
      const r = await api.git.pull(space.id, "ff-only");
      onChange(r.data);
      if (r.conflicts && r.conflicts.length) {
        raiseRebaseConflict(r.conflicts, r.output);
      } else {
        showMsg("Up to date", "success");
      }
    } catch (e: any) {
      if (e.body?.diverged) raiseDiverged();
      else showMsg(e.message, "error");
    } finally {
      setPulling(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    setMsg(null);
    try {
      const r = await api.git.push(space.id, false);
      onChange(r.data);
      showMsg("Pushed", "success");
    } catch (e: any) {
      const b = e.body || {};
      if (b.pushRejected) raisePushRejected();
      else if (b.noUpstream) raiseNoUpstream();
      else showMsg(e.message, "error");
    } finally {
      setPushing(false);
    }
  };

  // ── Issue builders: drop a system msg in chat + show an inline card ──
  const note = (text: string) => store.injectSystem(sessionId, text);
  const askPi = (prompt: string) => { store.send(sessionId, prompt, false); onClose(); onIssue(null); };

  const raiseRebaseConflict = (files: string[], _out: string) => {
    const cur = snap.currentBranch || "current";
    note(`🔀 Pull rebased with conflicts in ${files.length} file(s): ${files.join(", ")}. The rebase was aborted; the repo is clean.`);
    onIssue({
      title: "Pull — rebase conflicts",
      detail: `Rebasing ${cur} conflicted. The rebase was aborted so the repo is clean. Let pi resolve and finish the pull?`,
      files,
      actions: [
        { id: "pi", label: "Ask pi to resolve", primary: true, run: async () => askPi(buildAskPrompt("rebase", { cur, files })) },
        { id: "ignore", label: "Ignore", run: async () => onIssue(null) },
      ],
    });
  };
  const raiseDiverged = () => {
    const cur = snap.currentBranch || "current";
    note(`🔀 Pull diverged — ${cur} and its remote have diverged (fast-forward not possible).`);
    onIssue({
      title: "Pull — branches diverged",
      detail: `${cur} and its remote have diverged. Merge, rebase, or let pi handle it?`,
      actions: [
        { id: "merge", label: "Merge", run: async () => doPullMode("merge") },
        { id: "rebase", label: "Rebase", run: async () => doPullMode("rebase") },
        { id: "pi", label: "Ask pi", primary: true, run: async () => askPi(buildAskPrompt("rebase", { cur })) },
        { id: "ignore", label: "Cancel", run: async () => onIssue(null) },
      ],
    });
  };
  const raisePushRejected = () => {
    const cur = snap.currentBranch || "current";
    note(`🔀 Push rejected — the remote has commits you don't have yet. Pull first.`);
    onIssue({
      title: "Push — rejected",
      detail: `The remote has new commits on ${cur}. Pull first, or let pi pull + push?`,
      actions: [
        { id: "pull", label: "Pull first", run: async () => { onIssue(null); await handlePull(); } },
        { id: "pi", label: "Ask pi", primary: true, run: async () => askPi(buildAskPrompt("push", { cur })) },
        { id: "ignore", label: "Cancel", run: async () => onIssue(null) },
      ],
    });
  };
  const raiseNoUpstream = () => {
    const cur = snap.currentBranch || "current";
    note(`🔀 ${cur} has no upstream branch set.`);
    onIssue({
      title: "Push — no upstream",
      detail: `${cur} has no upstream. Set it and push to origin?`,
      actions: [
        { id: "up", label: "Push & set upstream", primary: true, run: async () => { const r = await api.git.push(space.id, true); onChange(r.data); onIssue(null); showMsg("Pushed & upstream set", "success"); } },
        { id: "ignore", label: "Cancel", run: async () => onIssue(null) },
      ],
    });
  };

  const doPullMode = async (mode: "merge" | "rebase") => {
    setPulling(true);
    try {
      const r = await api.git.pull(space.id, mode);
      onChange(r.data);
      if (r.conflicts && r.conflicts.length) raiseRebaseConflict(r.conflicts, r.output);
      else { onIssue(null); showMsg(mode === "merge" ? "Merged & pulled" : "Rebased & pulled", "success"); }
    } catch (e: any) {
      showMsg(e.message, "error");
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="git-changes">
      <div className="git-section-head">
        <span className="git-changes-count">Changes · {snap.files.length}</span>
        <div className="git-mini-row">
          <button className="git-mini-btn" onClick={handlePull} disabled={pulling}>
            ↓ {pulling ? "…" : "Pull"}
          </button>
          <button className="git-mini-btn" onClick={handlePush} disabled={pushing} title="Push current branch to its upstream">
            ↑ {pushing ? "…" : "Push"}
          </button>
        </div>
      </div>

      {snap.files.length === 0 ? (
        <div className="git-clean">
          <div className="git-clean-icon">✓</div>
          <div>Working tree clean</div>
          <div className="git-clean-sub">No uncommitted changes on {snap.currentBranch}</div>
        </div>
      ) : (
        <>
          <div className="git-review-layout">
            <div className="git-file-browser">
              <label className="git-select-all">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                <span>{allSelected ? "Deselect all" : "Select all"}</span>
              </label>
              <ul className="git-file-list">
                {snap.files.map((f) => (
                  <li key={f.path}>
                    <div className={`git-file-row ${selected.has(f.path) ? "selected" : ""} ${expanded === f.path ? "active" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(f.path)}
                        onChange={() => toggle(f.path)}
                      />
                      <span className="git-status-dot" style={{ background: STATUS_COLOR[f.status] }} title={f.status} />
                      <button className="git-file-info" onClick={() => openEditor(f.path, f.status)} aria-label={`Open ${f.path} in editor`}>
                        <span className="git-file-name">{basename(f.path)}</span>
                        <span className="git-file-dir">{dirname(f.path)}</span>
                      </button>
                      <span className="git-file-stats">
                        {f.additions !== null && <span className="stat-add">+{f.additions}</span>}
                        {f.deletions !== null && <span className="stat-del">-{f.deletions}</span>}
                        {f.additions === null && f.deletions === null && (
                          <span className="stat-new">{f.status === "untracked" ? "new" : f.status}</span>
                        )}
                      </span>
                      <button
                        className={`git-chev ${expanded === f.path ? "open" : ""}`}
                        onClick={() => loadDiff(f.path)}
                        title="View diff"
                      >›</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <section className="git-diff-pane" aria-live="polite">
              {expanded ? <>
                <div className="git-diff-pane-head"><b>{basename(expanded)}</b><span>Unified diff</span></div>
                {loadingDiff ? <div className="git-diff-loading">Loading diff…</div> : <DiffView text={diff} />}
              </> : <div className="git-diff-empty"><span>⌘</span><b>Select a file to inspect its diff</b><small>Review changes before you commit and push.</small></div>}
            </section>
          </div>
          {editorPath && (
            <FileEditor
              space={space}
              path={editorPath}
              onClose={() => setEditorPath(null)}
              onSaved={() => { api.git.status(space.id).then(onChange).catch(() => {}); showMsg("Saved — ready to review and commit", "success"); }}
            />
          )}
        </>
      )}

      {msg && (
        <div className={`git-msg git-msg-${msg.kind}`}>
          {msg.kind === "success" ? <CheckIcon /> : <WarnIcon />}
          <span className="git-msg-text">{msg.text}</span>
          {msg.kind === "error" && (
            <button className="git-msg-dismiss" onClick={() => setMsg(null)} title="Dismiss">
              <CloseIcon />
            </button>
          )}
        </div>
      )}

      <div className="git-commit-form">
        {snap.piBusy && (
          <div className="git-commit-warn">⚠ pi is editing — committing now may capture a partial state.</div>
        )}
        <input
          className="git-input"
          placeholder="Summary (required)"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <textarea
          className="git-input git-textarea"
          placeholder="Description (optional)"
          value={description}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          className="git-commit-btn"
          disabled={!summary.trim() || selected.size === 0 || committing}
          onClick={handleCommit}
        >
          {committing ? "Committing…" : `Commit ${selected.size || ""} file${selected.size === 1 ? "" : "s"} to ${snap.currentBranch || "branch"}`}
        </button>
      </div>
    </div>
  );
}
