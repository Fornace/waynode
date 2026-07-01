import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import type { Space, GitSnapshot } from "../types";
import "./GitSidebar.css";

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
interface GitIssueAction {
  id: string;
  label: string;
  primary?: boolean;
  run: () => Promise<void>;
}
interface GitIssue {
  title: string;
  detail: string;
  files?: string[];
  actions: GitIssueAction[];
}

/** Compose the user-visible prompt we send to pi when delegating resolution. */
function buildAskPrompt(kind: "merge" | "rebase" | "push", ctx: { cur: string; target?: string; files?: string[] }): string {
  const fl = ctx.files && ctx.files.length ? ` — ${ctx.files.join(", ")}` : "";
  if (kind === "merge") {
    return `Resolve the merge of \`${ctx.target}\` into \`${ctx.cur}\`. Run \`git merge ${ctx.target}\`; for any files with \`<<<<<<<\` conflict markers${fl}, resolve them based on both sides' intent, \`git add\` the resolved files, and finish with \`git commit\`. Summarize what you changed; if it isn't safely resolvable, stop and explain.`;
  }
  if (kind === "rebase") {
    return `The branch \`${ctx.cur}\` diverged from its remote. Run \`git pull --rebase\`; for any files with conflict markers${fl}, resolve them, then continue the rebase (\`git rebase --continue\`) per step. If it gets stuck, \`git rebase --abort\` and explain.`;
  }
  return `Push to remote was rejected (the remote has commits you don't). Run \`git pull --rebase\`, resolve any conflicts${fl}, then \`git push\` again. Summarize what happened.`;
}

const STATUS_COLOR: Record<string, string> = {
  modified: "var(--amber)",
  added: "var(--green)",
  deleted: "var(--red)",
  untracked: "var(--accent)",
  renamed: "#a78bfa",
  copied: "#a78bfa",
  conflict: "var(--red)",
};

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
            <BranchIcon />
            <span className="git-branch-current">{snap?.currentBranch || "…"}</span>
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

// ───────────────────────────── Changes ─────────────────────────────

function ChangesPanel({ space, sessionId, snap, onChange, onClose, onIssue }: { space: Space; sessionId: string; snap: GitSnapshot; onChange: (s: GitSnapshot) => void; onClose: () => void; onIssue: (i: GitIssue | null) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [loadingDiff, setLoadingDiff] = useState(false);
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
          <label className="git-select-all">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <span>{allSelected ? "Deselect all" : "Select all"}</span>
          </label>
          <ul className="git-file-list">
            {snap.files.map((f) => (
              <li key={f.path}>
                <div className={`git-file-row ${selected.has(f.path) ? "selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={() => toggle(f.path)}
                  />
                  <span className="git-status-dot" style={{ background: STATUS_COLOR[f.status] }} title={f.status} />
                  <button className="git-file-info" onClick={() => loadDiff(f.path)}>
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
                {expanded === f.path && (
                  loadingDiff ? (
                    <div className="git-diff-loading">Loading diff…</div>
                  ) : (
                    <DiffView text={diff} />
                  )
                )}
              </li>
            ))}
          </ul>
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

// ───────────────────────────── Branches ─────────────────────────────

function BranchesPanel({ space, sessionId, snap, onChange, onClose, onIssue }: { space: Space; sessionId: string; snap: GitSnapshot; onChange: (s: GitSnapshot) => void; onClose: () => void; onIssue: (i: GitIssue | null) => void }) {
  const [filter, setFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [mode, setMode] = useState<"stash" | "carry">("stash");
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cur = snap.currentBranch || "current";
  const filtered = snap.branches.filter((b) =>
    b.shortName.toLowerCase().includes(filter.toLowerCase())
  );
  const defaultBranches = filtered.filter((b) => b.isDefault && !b.isRemote);
  const recent = filtered.filter((b) => !b.isDefault && !b.isRemote && b.shortName !== cur).slice(0, 6);
  const remotes = filtered.filter((b) => b.isRemote).slice(0, 12);

  const startSwitch = (name: string) => {
    setErr(null);
    if (snap.hasUncommittedChanges) {
      setMode("stash");
      setSwitchTo(name);
    } else {
      doSwitch(name, "clean");
    }
  };

  const doSwitch = async (name: string, m: "stash" | "carry" | "clean") => {
    setBusy(true);
    setErr(null);
    try {
      const { data } = await api.git.switchBranch(space.id, { branchName: name, mode: m });
      onChange(data);
      setSwitchTo(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePull = async () => {
    setPulling(true);
    setErr(null);
    try {
      const r = await api.git.pull(space.id, "ff-only");
      onChange(r.data);
      if (r.conflicts && r.conflicts.length) raiseRebaseConflict(r.conflicts);
    } catch (e: any) {
      if (e.body?.diverged) raiseDiverged();
      else setErr(e.message);
    } finally {
      setPulling(false);
    }
  };

  const handleMerge = async (target: string) => {
    setBusy(true);
    setErr(null);
    setShowMerge(false);
    try {
      const r = await api.git.merge(space.id, target);
      onChange(r.data);
      if (r.aborted && r.conflicts?.length) raiseMergeConflict(target, r.conflicts);
      else setErr(`Merged ${target}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ── Issue builders (mirror ChangesPanel) ──
  const note = (text: string) => store.injectSystem(sessionId, text);
  const askPi = (prompt: string) => { store.send(sessionId, prompt, false); onClose(); onIssue(null); };

  const raiseMergeConflict = (target: string, files: string[]) => {
    note(`🔀 Merge conflict — merging \`${target}\` into \`${cur}\` conflicted in ${files.length} file(s): ${files.join(", ")}. The merge was aborted; the repo is clean.`);
    onIssue({
      title: "Merge — conflicts",
      detail: `Merging ${target} into ${cur} conflicted. The merge was aborted so the repo is clean. Let pi merge and resolve?`,
      files,
      actions: [
        { id: "pi", label: "Ask pi to resolve", primary: true, run: async () => askPi(buildAskPrompt("merge", { cur, target, files })) },
        { id: "retry", label: "Retry merge", run: async () => { onIssue(null); await handleMerge(target); } },
        { id: "ignore", label: "Ignore", run: async () => onIssue(null) },
      ],
    });
  };
  const raiseRebaseConflict = (files: string[]) => {
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
  const doPullMode = async (m: "merge" | "rebase") => {
    setPulling(true);
    try {
      const r = await api.git.pull(space.id, m);
      onChange(r.data);
      if (r.conflicts && r.conflicts.length) raiseRebaseConflict(r.conflicts);
      else onIssue(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="git-branches">
      <div className="git-section-head">
        <div>
          <div className="git-branches-label">Current branch</div>
          <div className="git-branches-cur">{cur}</div>
        </div>
        <button className="git-mini-btn" onClick={handlePull} disabled={pulling}>
          ↓ {pulling ? "…" : "Pull origin"}
        </button>
      </div>

      <div className="git-branch-controls">
        <input
          className="git-input"
          placeholder="Filter branches…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="git-new-branch-btn" onClick={() => setShowCreate(true)}>New Branch</button>
      </div>

      {err && <div className="git-error">{err}</div>}

      <div className="git-branch-list">
        {defaultBranches.length > 0 && (
          <BranchSection title="Default Branch">
            {defaultBranches.map((b) => (
              <BranchRow key={b.name} name={b.shortName} date={b.date} current={b.shortName === cur} onSwitch={() => startSwitch(b.shortName)} />
            ))}
          </BranchSection>
        )}
        {recent.length > 0 && (
          <BranchSection title="Recent Branches">
            {recent.map((b) => (
              <BranchRow key={b.name} name={b.shortName} date={b.date} current={b.shortName === cur} onSwitch={() => startSwitch(b.shortName)} />
            ))}
          </BranchSection>
        )}
        {remotes.length > 0 && (
          <BranchSection title="Other Branches">
            {remotes.map((b) => (
              <BranchRow key={b.name} name={b.shortName} date={b.date} current={b.shortName === cur} onSwitch={() => startSwitch(b.shortName)} remote />
            ))}
          </BranchSection>
        )}
        {filtered.length === 0 && <div className="git-empty">No branches match “{filter}”.</div>}
      </div>

      <button className="git-merge-btn" onClick={() => setShowMerge(true)}>
        Choose a branch to merge into {cur}
      </button>

      {showMerge && (
        <MergeModal
          current={cur}
          branches={snap.branches
            .filter((b) => b.shortName !== cur)
            .map((b) => ({ name: b.shortName, date: b.date, remote: b.isRemote }))}
          busy={busy}
          onCancel={() => setShowMerge(false)}
          onPick={(name) => handleMerge(name)}
        />
      )}
      {switchTo && (
        <SwitchBranchDialog
          target={switchTo}
          current={cur || "current"}
          mode={mode}
          setMode={setMode}
          busy={busy}
          onCancel={() => setSwitchTo(null)}
          onConfirm={() => doSwitch(switchTo, mode)}
        />
      )}
      {showCreate && (
        <CreateBranchModal
          base={cur || "main"}
          onCancel={() => setShowCreate(false)}
          onCreate={async (name) => {
            setBusy(true);
            setErr(null);
            try {
              const { data } = await api.git.createBranch(space.id, { branchName: name, baseBranch: cur || undefined });
              onChange(data);
              setShowCreate(false);
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}

function BranchSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="git-branch-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function BranchRow({ name, date, current, remote, onSwitch }: { name: string; date: string; current: boolean; remote?: boolean; onSwitch: () => void }) {
  return (
    <button className={`git-branch-row ${current ? "current" : ""}`} onClick={current ? undefined : onSwitch} disabled={current}>
      <BranchIcon dim />
      <span className="git-branch-row-name">{name}{remote && <span className="git-remote-tag">remote</span>}</span>
      <span className="git-branch-row-date">{current ? "✓ current" : date}</span>
    </button>
  );
}

// ───────────────────────────── Dialogs ─────────────────────────────

function SwitchBranchDialog({
  target, current, mode, setMode, busy, onCancel, onConfirm,
}: {
  target: string; current: string; mode: "stash" | "carry"; setMode: (m: "stash" | "carry") => void;
  busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="git-modal-overlay" onClick={onCancel}>
      <div className="git-modal" onClick={(e) => e.stopPropagation()}>
        <div className="git-modal-head">
          <h3>Switch Branch</h3>
          <button className="git-icon-btn" onClick={onCancel}><CloseIcon /></button>
        </div>
        <div className="git-modal-body">
          <p className="git-modal-lede">You have changes on this branch. What would you like to do with them?</p>
          <label className={`git-option ${mode === "stash" ? "checked" : ""}`}>
            <input type="radio" name="sw" checked={mode === "stash"} onChange={() => setMode("stash")} />
            <span className="git-option-text">
              <strong>Leave my changes on {current}</strong>
              <p>Your in-progress work will be stashed on this branch for you to return to later.</p>
            </span>
          </label>
          <label className={`git-option ${mode === "carry" ? "checked" : ""}`}>
            <input type="radio" name="sw" checked={mode === "carry"} onChange={() => setMode("carry")} />
            <span className="git-option-text">
              <strong>Bring my changes to {target}</strong>
              <p>Your in-progress work will follow you to the new branch.</p>
            </span>
          </label>
        </div>
        <div className="git-modal-foot">
          <button className="git-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="git-btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Switching…" : "Switch Branch"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateBranchModal({ base, onCancel, onCreate }: { base: string; onCancel: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="git-modal-overlay" onClick={onCancel}>
      <div className="git-modal" onClick={(e) => e.stopPropagation()}>
        <div className="git-modal-head">
          <h3>Create a Branch</h3>
          <button className="git-icon-btn" onClick={onCancel}><CloseIcon /></button>
        </div>
        <div className="git-modal-body">
          <label className="git-field-label">Name</label>
          <input
            className="git-input"
            autoFocus
            placeholder="my-feature"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }}
          />
          <div className="git-helper">
            Your new branch will be based on your currently checked out branch (<Pill>{base}</Pill>).
          </div>
        </div>
        <div className="git-modal-foot">
          <button className="git-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="git-btn-primary" onClick={() => name.trim() && onCreate(name.trim())} disabled={!name.trim()}>
            Create Branch
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── Issue card ─────────────────────────────

function GitIssueCard({ issue }: { issue: GitIssue }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = async (a: GitIssueAction) => {
    setBusyId(a.id);
    try { await a.run(); } finally { setBusyId(null); }
  };
  return (
    <div className="git-issue">
      <div className="git-issue-title">🔀 {issue.title}</div>
      <div className="git-issue-detail">{issue.detail}</div>
      {issue.files && issue.files.length > 0 && (
        <ul className="git-issue-files">
          {issue.files.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
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

function MergeModal({
  current, branches, busy, onCancel, onPick,
}: {
  current: string;
  branches: { name: string; date: string; remote?: boolean }[];
  busy: boolean;
  onCancel: () => void;
  onPick: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const list = branches.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="git-modal-overlay" onClick={onCancel}>
      <div className="git-modal" onClick={(e) => e.stopPropagation()}>
        <div className="git-modal-head">
          <h3>Merge into {current}</h3>
          <button className="git-icon-btn" onClick={onCancel}><CloseIcon /></button>
        </div>
        <div className="git-modal-body">
          <input className="git-input" placeholder="Filter branches…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
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

function DiffView({ text }: { text: string }) {
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

function basename(p: string) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
function dirname(p: string) { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(0, i) : ""; }

function BranchIcon({ dim }: { dim?: boolean }) {
  return (
    <svg className={`git-branch-ico ${dim ? "dim" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? "spin" : ""} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function Pill({ children }: { children: React.ReactNode }) {
  return <span className="git-pill">{children}</span>;
}
