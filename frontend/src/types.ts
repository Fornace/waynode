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
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string | null;
}

// ── Rich streaming message model (sessionStore) ──

export type ToolStatus = "running" | "done" | "error";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; args: any; output: string; status: ToolStatus };

export type ChatItem =
  | { id: string; role: "user"; content: string; isGoal?: boolean }
  | { id: string; role: "assistant"; blocks: Block[]; done: boolean }
  | { id: string; role: "system"; content: string };

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
