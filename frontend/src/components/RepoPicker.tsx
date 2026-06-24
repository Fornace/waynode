import { useState, useEffect, useRef, useMemo } from "react";
import type { RepoGroup } from "../types";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface RepoPickerProps {
  onClose: () => void;
  onClone: (repoUrl: string, branch: string, authUser?: string, authToken?: string) => Promise<void>;
  githubConnected: boolean;
  gitlabConnected: boolean;
}

type Tab = "github" | "gitlab" | "url";

export function RepoPicker({ onClose, onClone, githubConnected, gitlabConnected }: RepoPickerProps) {
  const [tab, setTab] = useState<Tab>(githubConnected ? "github" : "url");
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

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={onClose}>
      <div className="repo-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="repo-picker-header">
          <div className="repo-picker-title">Clone Repository</div>
          <button className="repo-picker-close" onClick={onClose}>✕</button>
        </div>

        <div className="repo-picker-tabs">
          <button
            className={`repo-tab ${tab === "github" ? "active" : ""}`}
            onClick={() => setTab("github")}
          >
            <GitHubIcon /> GitHub
          </button>
          <button
            className={`repo-tab ${tab === "gitlab" ? "active" : ""}`}
            onClick={() => setTab("gitlab")}
          >
            <GitLabIcon /> GitLab
          </button>
          <button
            className={`repo-tab ${tab === "url" ? "active" : ""}`}
            onClick={() => setTab("url")}
          >
            🔗 URL
          </button>
        </div>

        {error && <div className="repo-picker-error">{error}</div>}

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
                  <span className="repo-search-icon">🔍</span>
                  <input
                    ref={searchRef}
                    className="repo-search-input"
                    placeholder={`Search ${tab === "github" ? "GitHub" : "GitLab"} repos...`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button className="repo-search-clear" onClick={() => setSearch("")}>✕</button>
                  )}
                </div>

                <div className="repo-list">
                  {loading ? (
                    <div className="repo-loading">
                      <Spinner /> Loading repositories...
                    </div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="repo-empty">
                      {search ? `No repos matching "${search}"` : "No repositories found"}
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
                          <div
                            key={repo.id}
                            className="repo-item"
                            onClick={() => !cloning && handleCloneRepo(repo.url, repo.default_branch || "main")}
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
                          </div>
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
          <div className="repo-url-form">
            <div className="form-field">
              <label className="form-label">Repository URL</label>
              <input
                className="form-input"
                placeholder="https://github.com/user/repo.git"
                value={urlRepo}
                onChange={(e) => setUrlRepo(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-field">
              <label className="form-label">Branch</label>
              <input
                className="form-input"
                placeholder="main"
                value={urlBranch}
                onChange={(e) => setUrlBranch(e.target.value)}
              />
            </div>
            <div className="form-auth-toggle" onClick={() => setShowAuth(!showAuth)}>
              {showAuth ? "▼" : "▶"} Private repo credentials (optional)
            </div>
            {showAuth && (
              <div className="form-auth-fields">
                <div className="form-field">
                  <label className="form-label">Username / Token Name</label>
                  <input
                    className="form-input"
                    placeholder="username or token name"
                    value={authUser}
                    onChange={(e) => setAuthUser(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label className="form-label">Password / Access Token</label>
                  <input
                    className="form-input"
                    type="password"
                    placeholder="••••••••"
                    value={authToken}
                    onChange={(e) => setAuthToken(e.target.value)}
                  />
                </div>
              </div>
            )}
            {cloning && <div className="repo-loading"><Spinner /> Cloning...</div>}
            <button
              className="repo-url-clone-btn"
              onClick={handleUrlClone}
              disabled={!urlRepo.trim() || cloning}
            >
              {cloning ? "Cloning..." : "Clone Repository"}
            </button>
          </div>
        )}
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

function GitHubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}

function GitLabIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.955 13.587l-1.347-4.135-2.673-8.228a.456.456 0 00-.867 0l-2.672 8.228H7.604l-2.673-8.228a.456.456 0 00-.867 0L1.392 9.452.045 13.587a.924.924 0 00.331 1.022L12 23.054l11.624-8.445a.92.92 0 00.331-1.022"/>
    </svg>
  );
}

function Spinner() {
  return <span className="spinner" />;
}
