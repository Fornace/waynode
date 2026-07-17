import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../api/client";
import type { Space, GitSnapshot } from "../types";
import { BranchesPanel } from "./GitBranchesPanel";
import { ChangesPanel } from "./GitChangesPanel";
import { BranchIcon, CloseIcon, GitIssueCard, RefreshIcon, type GitIssue } from "./GitSidebarShared";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import "./GitSidebarLayout.css";
import "./GitSidebarActions.css";
import "./GitReviewEvidence.css";

interface GitSidebarProps {
  space: Space;
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

type Tab = "changes" | "branches";

const REVIEW_WIDTH_KEY = "waynode.git-review.width";
const REVIEW_DEFAULT_WIDTH = 720;
const REVIEW_MIN_WIDTH = 420;
const REVIEW_MAX_WIDTH = 960;
const REVIEW_OVERLAY_QUERY = "(max-width: 1100px)";

function maxReviewWidth() {
  return Math.max(REVIEW_MIN_WIDTH, Math.min(REVIEW_MAX_WIDTH, window.innerWidth * 0.5));
}

function clampReviewWidth(value: number) {
  return Math.round(Math.min(maxReviewWidth(), Math.max(REVIEW_MIN_WIDTH, value)));
}

function savedReviewWidth() {
  try {
    const saved = Number(window.localStorage.getItem(REVIEW_WIDTH_KEY));
    return clampReviewWidth(Number.isFinite(saved) && saved > 0 ? saved : REVIEW_DEFAULT_WIDTH);
  } catch {
    return clampReviewWidth(REVIEW_DEFAULT_WIDTH);
  }
}

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
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [compact, setCompact] = useState(() => window.matchMedia(REVIEW_OVERLAY_QUERY).matches);
  const [reviewWidth, setReviewWidth] = useState(savedReviewWidth);
  const reviewWidthRef = useRef(reviewWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  useEscapeToClose(onClose, panelRef, open && compact);

  useLayoutEffect(() => {
    if (!open || !compact || !panelRef.current) return;
    const returnFocus = document.querySelector<HTMLElement>("[data-review-trigger]")
      || document.activeElement as HTMLElement | null;
    const parent = panelRef.current.parentElement;
    if (!parent) return;
    const background = [...parent.children].filter((node) => node !== panelRef.current && !node.classList.contains("git-overlay"));
    const previous = background.map((node) => ({
      node: node as HTMLElement,
      inert: (node as HTMLElement).inert,
      ariaHidden: node.getAttribute("aria-hidden"),
    }));
    previous.forEach(({ node }) => { node.inert = true; node.setAttribute("aria-hidden", "true"); });
    const focusFrame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      previous.forEach(({ node, inert, ariaHidden }) => {
        node.inert = inert;
        if (ariaHidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", ariaHidden);
      });
      requestAnimationFrame(() => returnFocus?.focus());
    };
  }, [open, compact]);

  useEffect(() => {
    const media = window.matchMedia(REVIEW_OVERLAY_QUERY);
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => {
      const next = clampReviewWidth(reviewWidthRef.current);
      reviewWidthRef.current = next;
      setReviewWidth(next);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const oldCursor = document.body.style.cursor;
    const oldUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const next = clampReviewWidth(dragRef.current.startWidth + dragRef.current.startX - event.clientX);
      reviewWidthRef.current = next;
      setReviewWidth(next);
    };
    const finish = () => {
      dragRef.current = null;
      setResizing(false);
      try { window.localStorage.setItem(REVIEW_WIDTH_KEY, String(reviewWidthRef.current)); } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    return () => {
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldUserSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [resizing]);

  const persistWidth = (next: number) => {
    const width = clampReviewWidth(next);
    reviewWidthRef.current = width;
    setReviewWidth(width);
    try { window.localStorage.setItem(REVIEW_WIDTH_KEY, String(width)); } catch {}
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = reviewWidth + 32;
    else if (event.key === "ArrowRight") next = reviewWidth - 32;
    else if (event.key === "Home") next = REVIEW_MIN_WIDTH;
    else if (event.key === "End") next = maxReviewWidth();
    if (next === null) return;
    event.preventDefault();
    persistWidth(next);
  };

  const moveTab = (event: ReactKeyboardEvent<HTMLButtonElement>, current: number) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? 1
      : event.key === "ArrowRight" ? (current + 1) % 2
      : (current - 1 + 2) % 2;
    const nextTab: Tab = next === 0 ? "changes" : "branches";
    setTab(nextTab);
    tabRefs.current[next]?.focus();
  };

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
      {open && compact && <div className="git-overlay" aria-hidden="true" onClick={onClose} />}
      <aside
        ref={panelRef}
        className={`git-panel ${open ? "open" : ""} ${resizing ? "is-resizing" : ""}`}
        style={{ "--git-review-width": `${reviewWidth}px` } as CSSProperties}
        role={compact ? "dialog" : "complementary"}
        aria-modal={open && compact ? true : undefined}
        aria-labelledby="git-review-title"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
      >
        <div
          className="git-resize-handle"
          role="separator"
          aria-label="Resize Git review"
          aria-orientation="vertical"
          aria-valuemin={REVIEW_MIN_WIDTH}
          aria-valuemax={maxReviewWidth()}
          aria-valuenow={reviewWidth}
          aria-valuetext={`${reviewWidth} pixels wide`}
          tabIndex={compact ? -1 : 0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragRef.current = { startX: event.clientX, startWidth: reviewWidthRef.current };
            setResizing(true);
          }}
          onDoubleClick={() => persistWidth(REVIEW_DEFAULT_WIDTH)}
          onKeyDown={resizeWithKeyboard}
        />
        <header className="git-header">
          <div className="git-header-title">
            <span className="git-worktree-icon"><BranchIcon /></span>
            <span className="git-worktree-heading">
              <b id="git-review-title">Git worktree</b>
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
            <button className="git-icon-btn" onClick={refresh} title="Refresh" aria-label="Refresh Git status">
              <RefreshIcon spinning={loading} />
            </button>
            <button ref={closeRef} className="git-icon-btn git-close-btn" onClick={onClose} title="Close" aria-label="Close Git review">
              <CloseIcon />
            </button>
          </div>
        </header>

        {snap?.piBusy && (
          <div className="git-pi-busy" role="status">
            <span className="pulse" aria-hidden="true" /> Agent is editing files. Review may change until this run finishes.
          </div>
        )}
        {error && <div className="git-error" role="alert"><span>Couldn’t refresh this worktree. Existing review data is unchanged.</span><button type="button" onClick={refresh}>Retry</button></div>}

        {issue && <GitIssueCard issue={issue} />}

        <nav className="git-tabs" role="tablist" aria-label="Git review sections">
          <button ref={(node) => { tabRefs.current[0] = node; }} id="git-changes-tab" role="tab" tabIndex={tab === "changes" ? 0 : -1} aria-selected={tab === "changes"} aria-controls="git-review-panel" className={`git-tab ${tab === "changes" ? "active" : ""}`} onKeyDown={(event) => moveTab(event, 0)} onClick={() => setTab("changes")}>
            Changes{snap ? ` (${snap.files.length})` : ""}
          </button>
          <button ref={(node) => { tabRefs.current[1] = node; }} id="git-branches-tab" role="tab" tabIndex={tab === "branches" ? 0 : -1} aria-selected={tab === "branches"} aria-controls="git-review-panel" className={`git-tab ${tab === "branches" ? "active" : ""}`} onKeyDown={(event) => moveTab(event, 1)} onClick={() => setTab("branches")}>
            Branches
          </button>
        </nav>

        <div className="git-body" id="git-review-panel" role="tabpanel" aria-labelledby={tab === "changes" ? "git-changes-tab" : "git-branches-tab"}>
          {loading && !snap ? (
            <div className="git-empty" role="status">Checking worktree…</div>
          ) : !snap ? (
            <div className="git-empty">Worktree status is unavailable. Retry above.</div>
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
