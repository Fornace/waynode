import { useRef, useState } from "react";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import type { Space, GitSnapshot } from "../types";
import { BranchIcon, CloseIcon, MergeModal, Pill, buildAskPrompt, type GitIssue } from "./GitSidebarShared";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

// ───────────────────────────── Branches ─────────────────────────────

export function BranchesPanel({ space, sessionId, snap, onChange, onClose, onIssue }: { space: Space; sessionId: string; snap: GitSnapshot; onChange: (s: GitSnapshot) => void; onClose: () => void; onIssue: (i: GitIssue | null) => void }) {
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
    } catch {
      setErr("Couldn’t switch branches. Your current branch and changes are preserved.");
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
      else setErr("Couldn’t pull from the remote. Your local work is preserved; try again.");
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
    } catch {
      setErr("Couldn’t merge that branch. Your current branch is preserved.");
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
      detail: `Merging ${target} into ${cur} conflicted. The merge was aborted so the repo is clean. Let the agent merge and resolve?`,
      files,
      actions: [
        { id: "pi", label: "Ask agent to resolve", primary: true, run: async () => askPi(buildAskPrompt("merge", { cur, target, files })) },
        { id: "retry", label: "Retry merge", run: async () => { onIssue(null); await handleMerge(target); } },
        { id: "ignore", label: "Ignore", run: async () => onIssue(null) },
      ],
    });
  };
  const raiseRebaseConflict = (files: string[]) => {
    note(`🔀 Pull rebased with conflicts in ${files.length} file(s): ${files.join(", ")}. The rebase was aborted; the repo is clean.`);
    onIssue({
      title: "Pull — rebase conflicts",
      detail: `Rebasing ${cur} conflicted. The rebase was aborted so the repo is clean. Let the agent resolve and finish the pull?`,
      files,
      actions: [
        { id: "pi", label: "Ask agent to resolve", primary: true, run: async () => askPi(buildAskPrompt("rebase", { cur, files })) },
        { id: "ignore", label: "Ignore", run: async () => onIssue(null) },
      ],
    });
  };
  const raiseDiverged = () => {
    note(`🔀 Pull diverged — ${cur} and its remote have diverged (fast-forward not possible).`);
    onIssue({
      title: "Pull — branches diverged",
      detail: `${cur} and its remote have diverged. Merge, rebase, or let the agent handle it?`,
      actions: [
        { id: "merge", label: "Merge", run: async () => doPullMode("merge") },
        { id: "rebase", label: "Rebase", run: async () => doPullMode("rebase") },
        { id: "pi", label: "Ask agent", primary: true, run: async () => askPi(buildAskPrompt("rebase", { cur })) },
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
    } catch {
      setErr("Couldn’t update from the remote. Your local work is preserved; try again.");
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
          aria-label="Filter branches"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="git-new-branch-btn" onClick={() => setShowCreate(true)}>New Branch</button>
      </div>

      {err && <div className="git-error" role="alert">{err}</div>}

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
            } catch {
              setErr("Couldn’t create that branch. Your current branch is unchanged.");
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
  const overlayRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(onCancel, overlayRef);
  return (
    <div className="git-modal-overlay" ref={overlayRef} onClick={onCancel}>
      <div className="git-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="switch-branch-title">
        <div className="git-modal-head">
          <h3 id="switch-branch-title">Switch branch</h3>
          <button className="git-icon-btn" onClick={onCancel} aria-label="Cancel branch switch"><CloseIcon /></button>
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
  const overlayRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(onCancel, overlayRef);
  return (
    <div className="git-modal-overlay" ref={overlayRef} onClick={onCancel}>
      <div className="git-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-branch-title">
        <div className="git-modal-head">
          <h3 id="create-branch-title">Create a branch</h3>
          <button className="git-icon-btn" onClick={onCancel} aria-label="Cancel branch creation"><CloseIcon /></button>
        </div>
        <div className="git-modal-body">
          <label className="git-field-label" htmlFor="new-branch-name">Name</label>
          <input
            id="new-branch-name"
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
