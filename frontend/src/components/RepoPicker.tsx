import { useState, useEffect, useRef, useMemo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { RepoGroup } from "../types";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { GitHubIcon, GitLabIcon, SearchIcon } from "./RepoProviderIcons";

interface RepoPickerProps {
  onClose: () => void;
  onClone: (repoUrl: string, branch: string, authUser?: string, authToken?: string) => Promise<void>;
  githubConnected: boolean;
  gitlabConnected: boolean;
  githubAvailable: boolean;
  gitlabAvailable: boolean;
}

type Tab = "github" | "gitlab" | "url";

export function RepoPicker({ onClose, onClone, githubConnected, gitlabConnected, githubAvailable, gitlabAvailable }: RepoPickerProps) {
  const [tab, setTab] = useState<Tab>(githubAvailable && githubConnected ? "github" : gitlabAvailable && gitlabConnected ? "gitlab" : "url");
  const [search, setSearch] = useState("");
  const [githubGroups, setGithubGroups] = useState<RepoGroup[]>([]);
  const [gitlabGroups, setGitlabGroups] = useState<RepoGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState("");
  const [urlRepo, setUrlRepo] = useState("");
  const [urlBranch, setUrlBranch] = useState("main");
  const [authUser, setAuthUser] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Layer 1: Esc closes this picker; focus trapped so the terminal behind it
  // stops receiving keystrokes while the picker is open.
  useEscapeToClose(onClose, overlayRef);

  // APG roving-tabIndex tabs (ported from GitSidebar.tsx moveTab). Visible
  // tabs depend on which hosted-git providers are available on this install.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs: { key: Tab; label: ReactNode }[] = [
    ...(githubAvailable ? [{ key: "github" as Tab, label: <><GitHubIcon /> GitHub</> }] : []),
    ...(gitlabAvailable ? [{ key: "gitlab" as Tab, label: <><GitLabIcon /> GitLab</> }] : []),
    { key: "url" as Tab, label: <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> URL</> },
  ];
  const moveTab = (event: ReactKeyboardEvent<HTMLButtonElement>, current: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
    setTab(tabs[next].key); tabRefs.current[next]?.focus();
  };

  useEffect(() => {
    if (tab === "github" && githubConnected) loadGithub();
    if (tab === "gitlab" && gitlabConnected) loadGitlab();
  }, [tab]);

  useEffect(() => {
    if (searchRef.current) searchRef.current.focus();
  }, [tab]);

  const loadGithub = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/repos/github", {
        headers: getAuthHeaders(),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "GitHub repositories could not be loaded.");
      if (data.error) throw new Error(data.error);
      setGithubGroups(data.groups || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadGitlab = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/repos/gitlab", {
        headers: getAuthHeaders(),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "GitLab repositories could not be loaded.");
      if (data.error) throw new Error(data.error);
      setGitlabGroups(data.groups || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const filteredGroups = useMemo(() => {
    const groups = tab === "github" ? githubGroups : gitlabGroups;
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        repos: g.repos.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.full_name?.toLowerCase().includes(q) ||
            r.description?.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.repos.length > 0);
  }, [tab, githubGroups, gitlabGroups, search]);

  const handleCloneRepo = async (url: string, branch: string) => {
    setCloning(true);
    setError("");
    try {
      await onClone(url, branch);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCloning(false);
    }
  };

  const handleUrlClone = async () => {
    if (!urlRepo.trim()) return;
    setCloning(true);
    setError("");
    try {
      await onClone(
        urlRepo.trim(),
        urlBranch.trim() || "main",
        authUser.trim() || undefined,
        authToken.trim() || undefined
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCloning(false);
    }
  };

  const retryCurrent = () => {
    if (tab === "github") loadGithub();
    else if (tab === "gitlab") loadGitlab();
    else handleUrlClone();
  };

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={onClose}>
      <div className="repo-picker-modal" role="dialog" aria-modal="true" aria-labelledby="repo-picker-title" onClick={(e) => e.stopPropagation()}>
        <div className="repo-picker-header">
          <div className="repo-picker-title" id="repo-picker-title">New worktree</div>
          <button type="button" className="repo-picker-close" onClick={onClose} aria-label="Close repository picker">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        <div className="repo-picker-tabs">
          <div className="tabs" role="tablist" aria-label="Repository source">
            {tabs.map((t, i) => (
              <button key={t.key} type="button" ref={(node) => { tabRefs.current[i] = node; }} role="tab" id={`repo-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="repo-picker-panel" tabIndex={tab === t.key ? 0 : -1} className={`tab-btn ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)} onKeyDown={(event) => moveTab(event, i)}>{t.label}</button>
            ))}
          </div>
        </div>

        <div id="repo-picker-panel" role="tabpanel" aria-labelledby={`repo-tab-${tab}`} tabIndex={0}>
        {error && <div className="repo-picker-error" role="alert"><span>{error}</span><button type="button" onClick={retryCurrent}>Try again</button></div>}

        {tab !== "url" && (
          <>
            {(tab === "github" && !githubConnected) || (tab === "gitlab" && !gitlabConnected) ? (
              <div className="repo-picker-connect">
                <div className="connect-icon">{tab === "github" ? <GitHubIcon size={32} /> : <GitLabIcon size={32} />}</div>
                <div className="connect-text">
                  Connect your {tab === "github" ? "GitHub" : "GitLab"} account to browse and clone repositories.
                </div>
                <a
                  className="connect-btn"
                  href={tab === "github" ? "/auth/github" : "/auth/gitlab"}
                >
                  Connect {tab === "github" ? "GitHub" : "GitLab"}
                </a>
              </div>
            ) : (
              <>
                <div className="repo-search-wrap">
                  <span className="repo-search-icon"><SearchIcon /></span>
                  <input
                    ref={searchRef}
                    className="repo-search-input"
                    placeholder={`Search ${tab === "github" ? "GitHub" : "GitLab"} repos...`}
                    aria-label={`Search ${tab === "github" ? "GitHub" : "GitLab"} repositories`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button type="button" className="repo-search-clear" onClick={() => setSearch("")} aria-label="Clear repository search">Clear</button>
                  )}
                </div>

                <div className="repo-list">
                  {loading ? (
                    <div className="repo-loading" role="status">
                      <Spinner /> Loading repositories…
                    </div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="repo-empty">
                      <strong>{search ? "No matching repositories" : "No repositories found"}</strong>
                      <span>{search ? `Nothing matched “${search}”.` : `No repositories are available from ${tab === "github" ? "GitHub" : "GitLab"}.`}</span>
                      <button type="button" onClick={search ? () => setSearch("") : retryCurrent}>{search ? "Clear search" : "Refresh"}</button>
                    </div>
                  ) : (
                    filteredGroups.map((group) => (
                      <div key={group.owner} className="repo-group">
                        <div className="repo-group-header">
                          {group.avatar && <img src={group.avatar} alt="" className="repo-group-avatar" />}
                          <span className="repo-group-name">{group.owner}</span>
                          <span className="repo-group-count">{group.repos.length}</span>
                        </div>
                        {group.repos.map((repo) => (
                          <button type="button"
                            key={repo.id}
                            className="repo-item"
                            onClick={() => !cloning && handleCloneRepo(repo.url, repo.default_branch || "main")}
                            disabled={cloning}
                            aria-label={`Clone ${repo.full_name || repo.name}`}
                          >
                            <div className="repo-item-main">
                              <span className="repo-item-name">{repo.name}</span>
                              {repo.private && <span className="repo-badge private">private</span>}
                              {repo.fork && <span className="repo-badge fork">fork</span>}
                              {repo.language && <span className="repo-badge lang">{repo.language}</span>}
                            </div>
                            {repo.description && (
                              <div className="repo-item-desc">{repo.description}</div>
                            )}
                            <div className="repo-item-meta">
                              {repo.stars !== undefined && repo.stars > 0 && <span>★ {repo.stars}</span>}
                              {repo.default_branch && <span>⎇ {repo.default_branch}</span>}
                              {repo.updated_at && (
                                <span>{timeAgo(repo.updated_at)}</span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </>
        )}

        {tab === "url" && (
          <form className="repo-url-form" onSubmit={(event) => { event.preventDefault(); void handleUrlClone(); }}>
            <div className="form-field">
              <label className="form-label" htmlFor="repo-url">Repository URL</label>
              <input
                className="form-input"
                id="repo-url"
                placeholder="https://github.com/user/repo.git"
                autoComplete="url"
                inputMode="url"
                value={urlRepo}
                onChange={(e) => setUrlRepo(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="repo-branch">Branch</label>
              <input
                className="form-input"
                id="repo-branch"
                placeholder="main"
                value={urlBranch}
                onChange={(e) => setUrlBranch(e.target.value)}
              />
            </div>
            <button type="button" className="form-auth-toggle" onClick={() => setShowAuth(!showAuth)} aria-expanded={showAuth} aria-controls="repo-auth-fields">
              <span aria-hidden="true">{showAuth ? "−" : "+"}</span> Private repository credentials <small>Optional</small>
            </button>
            {showAuth && (
              <div className="form-auth-fields" id="repo-auth-fields">
                <div className="form-field">
                  <label className="form-label" htmlFor="repo-auth-user">Username or token name</label>
                  <input
                    className="form-input"
                    id="repo-auth-user"
                    placeholder="username or token name"
                    autoComplete="username"
                    value={authUser}
                    onChange={(e) => setAuthUser(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="repo-auth-token">Password or access token</label>
                  <input
                    className="form-input"
                    id="repo-auth-token"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={authToken}
                    onChange={(e) => setAuthToken(e.target.value)}
                  />
                </div>
              </div>
            )}
            {cloning && <div className="repo-loading" role="status"><Spinner /> Cloning…</div>}
            <button
              type="submit"
              className="repo-url-clone-btn"
              disabled={!urlRepo.trim() || cloning}
            >
              {cloning ? "Cloning…" : "Clone worktree"}
            </button>
          </form>
        )}
        </div>
      </div>
    </div>
  );
}

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
