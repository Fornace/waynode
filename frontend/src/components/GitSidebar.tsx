import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Space, GitSnapshot } from "../types";
import { BranchesPanel } from "./GitBranchesPanel";
import { ChangesPanel } from "./GitChangesPanel";
import { BranchIcon, CloseIcon, GitIssueCard, RefreshIcon, type GitIssue } from "./GitSidebarShared";
import "./GitSidebarLayout.css";
import "./GitSidebarActions.css";

interface GitSidebarProps {
  space: Space;
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

type Tab = "changes" | "branches";

// A git operation hit a snag (merge conflict, divergent pull, rejected push).
// The sidebar surfaces it as an inline card AND drops a system message into the
// chat, offering to let pi (which lives in the same working tree) resolve it.
export function GitSidebar({ space, sessionId, open, onClose }: GitSidebarProps) {
  const [snap, setSnap] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("changes");
  const [issue, setIssue] = useState<GitIssue | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // ── Live data: only poll while open ──
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.git
      .status(space.id)
      .then((d) => { if (!cancelled) setSnap(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    const es = api.git.stream(space.id);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") setSnap(msg.data);
        else if (msg.type === "error") setError(msg.message);
      } catch {}
    };
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => {
      cancelled = true;
      es.close();
      esRef.current = null;
    };
  }, [open, space.id]);

  const refresh = () => api.git.status(space.id).then(setSnap).catch((e) => setError(e.message));

  return (
    <>
      {open && <div className="git-overlay" onClick={onClose} />}
      <aside className={`git-panel ${open ? "open" : ""}`} aria-hidden={!open}>
        <header className="git-header">
          <div className="git-header-title">
            <span className="git-worktree-icon"><BranchIcon /></span>
            <span className="git-worktree-heading">
              <b>Git worktree</b>
              <small>{space.repo_name} · {snap?.currentBranch || "…"}</small>
            </span>
            {snap && !snap.detached && snap.upstream && (
              <span className="git-ahead-behind" title={`${snap.upstream} · ↑${snap.ahead} ↓${snap.behind}`}>
                {snap.ahead > 0 && <span className="ab-ahead">↑{snap.ahead}</span>}
                {snap.behind > 0 && <span className="ab-behind">↓{snap.behind}</span>}
              </span>
            )}
          </div>
          <div className="git-header-actions">
            <button className="git-icon-btn" onClick={refresh} title="Refresh">
              <RefreshIcon spinning={loading} />
            </button>
            <button className="git-icon-btn git-close-btn" onClick={onClose} title="Close">
              <CloseIcon />
            </button>
          </div>
        </header>

        {snap?.piBusy && (
          <div className="git-pi-busy">
            <span className="pulse">⚡</span> pi is working — changes may be in progress
          </div>
        )}
        {error && <div className="git-error">{error}</div>}

        {issue && <GitIssueCard issue={issue} />}

        <nav className="git-tabs">
          <button className={`git-tab ${tab === "changes" ? "active" : ""}`} onClick={() => setTab("changes")}>
            Changes{snap ? ` (${snap.files.length})` : ""}
          </button>
          <button className={`git-tab ${tab === "branches" ? "active" : ""}`} onClick={() => setTab("branches")}>
            Branches
          </button>
        </nav>

        <div className="git-body">
          {loading && !snap ? (
            <div className="git-empty">Loading git…</div>
          ) : !snap ? (
            <div className="git-empty">No data</div>
          ) : tab === "changes" ? (
            <ChangesPanel space={space} sessionId={sessionId} snap={snap} onChange={setSnap} onClose={onClose} onIssue={setIssue} />
          ) : (
            <BranchesPanel space={space} sessionId={sessionId} snap={snap} onChange={setSnap} onClose={onClose} onIssue={setIssue} />
          )}
        </div>
      </aside>
    </>
  );
}
