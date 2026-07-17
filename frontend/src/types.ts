export interface User {
  id: string;
  github_id: number | null;
  gitlab_id: number | null;
  name: string;
  email: string | null;
  avatar_url: string | null;
}

export interface Space {
  id: string;
  owner_id: string;
  repo_url: string;
  repo_name: string;
  repo_full_name: string | null;
  branch: string;
  local_path: string;
  created_at: string;
  session_count?: number;
  my_role?: string;
}

export interface Session {
  id: string;
  space_id: string;
  owner_id: string;
  title: string;
  pi_session_dir: string;
  model: string | null;
  provider: string | null;
  composer_mode?: ComposerMode;
  archived?: number | boolean;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string | null;
  createdAt?: string;
  created_at?: string;
  timestamp?: string | null;
}

export type SubmissionStatus = "sending" | "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
export type ComposerMode = "message" | "goal" | "hammersmith";

export interface Submission {
  id: string;
  prompt: string;
  mode: ComposerMode;
  isGoal?: boolean;
  status: SubmissionStatus;
  error?: string;
  createdAt?: string;
  created_at?: string;
  timestamp?: string;
  jobId?: string;
  job?: HammersmithRun;
}

// ── Rich streaming message model (sessionStore) ──

export type ToolStatus = "running" | "done" | "error";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; args: any; output: string; status: ToolStatus; startedAt?: number; endedAt?: number };

export type ChatItem =
  | { id: string; role: "user"; content: string; sentAt: string | null; mode?: ComposerMode; isGoal?: boolean; submissionStatus?: SubmissionStatus }
  | { id: string; role: "assistant"; blocks: Block[]; done: boolean; sentAt: string | null }
  | { id: string; role: "system"; content: string; sentAt: string | null; key?: string }
  | { id: string; role: "hammersmith-run"; initiatingItemId: string; run: HammersmithRun; sentAt: string | null };

export interface HammersmithCapability {
  available: boolean;
  installed: boolean;
  dashboardUrl: string | null;
  version?: string;
  state?: "ready" | "setup-required" | "unsupported";
}

export interface HammersmithSettings {
  dashboardUrl: string | null;
  hostingMode: "self-hosted" | "hosted";
  defaultEngine: "pi" | "codex" | "opencode" | "grok";
  hostingModeLocked: boolean;
  capability?: HammersmithCapability;
}

export interface HammersmithRun {
  id: string;
  submissionId: string;
  runId: string | null;
  sessionId: string;
  spaceId: string;
  description: string;
  lifecycle: "running" | "finished" | "stopped";
  freshness: "loading" | "live" | "stale" | "reconnecting" | "unavailable";
  totalTasks: number;
  checkedTasks: number;
  passedTasks: number;
  failedTasks: number;
  updatedAt: string;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  monitorUrl: string | null;
}

export interface GoalStatus {
  status: "active" | "paused" | "complete" | "budgetLimited" | null;
  objective?: string;
  tokenBudget?: number;
  tokenUsage?: number;
  elapsedMs?: number;
}

export interface SSEEvent {
  type: "start" | "delta" | "stderr" | "done" | "error";
  text?: string;
  msgId?: string;
  isGoal?: boolean;
  exitCode?: number;
  message?: string;
}

export interface RepoItem {
  id: number;
  name: string;
  full_name: string;
  url: string;
  ssh_url: string;
  private: boolean;
  fork: boolean;
  default_branch: string;
  description: string | null;
  stars: number;
  updated_at: string;
  language: string | null;
  html_url: string;
}

export interface RepoGroup {
  owner: string;
  avatar: string | null;
  url: string;
  repos: RepoItem[];
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  my_role?: string;
  space_count?: number;
}

// ── Git sidebar ──
export interface GitFile {
  path: string;
  staged: string;   // porcelain X char (' ' = clean, M/A/D/R/C/U)
  worktree: string; // porcelain Y char
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "conflict" | "untracked";
  additions: number | null;
  deletions: number | null;
}
export interface GitBranch {
  name: string;
  shortName: string;
  sha: string;
  date: string;
  upstream?: string;
  isRemote: boolean;
  isDefault: boolean;
}
export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}
export interface GitSnapshot {
  currentBranch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
  files: GitFile[];
  commits: GitCommit[];
  branches: GitBranch[];
  defaultBranch: string | null;
  piBusy: boolean;
}
