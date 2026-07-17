import type { User, Space, Session, GoalStatus, ChatMessage, GitSnapshot, Org, ComposerMode, HammersmithCapability, HammersmithRun, HammersmithSettings } from "../types";

const base = "";

function getDevToken() {
  return localStorage.getItem("waynode-dev-token") || "";
}

function getAuthHeaders(): Record<string, string> {
  const token = getDevToken();
  return token ? { "x-dev-token": token } : {};
}

function getAuthQuery() {
  const token = getDevToken();
  return token ? `?t=${encodeURIComponent(token)}` : "";
}

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(base + url, {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const e: any = new Error(body.error || `HTTP ${res.status}`);
    e.body = body;
    e.status = res.status;
    throw e;
  }
  return res.json();
}

export const api = {
  auth: {
    me: () => fetchJSON<{
      user: User | null;
      providers: { github: boolean; gitlab: boolean; dev?: boolean };
      availableProviders: { github: boolean; gitlab: boolean };
      capabilities?: { terminal?: boolean };
    }>("/api/auth/me"),
    logout: () => fetchJSON("/auth/logout", { method: "POST" }),
    deletionCheck: () => fetchJSON<{ can_delete: boolean; blockers: Array<{ id: string; name: string; slug: string }> }>("/api/auth/account/deletion-check"),
    deleteAccount: () => fetchJSON("/api/auth/account", { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) }),
  },

  tokens: {
    list: () => fetchJSON<{ tokens: Array<{ id: string; label: string; created_at: string; last_used_at: string | null }> }>("/api/tokens"),
    create: (label: string) => fetchJSON<{ id: string; token: string; label: string }>("/api/tokens", { method: "POST", body: JSON.stringify({ label }) }),
    revoke: (id: string) => fetchJSON<{ ok: boolean }>(`/api/tokens/${id}`, { method: "DELETE" }),
  },

  orgs: {
    list: () => fetchJSON<Org[]>("/api/orgs"),
    create: (name: string) => fetchJSON<Org>("/api/orgs", { method: "POST", body: JSON.stringify({ name }) }),
  },

  spaces: {
    list: () => fetchJSON<Space[]>("/api/spaces"),
    get: (id: string) => fetchJSON<Space>(`/api/spaces/${id}`),
    create: (repoUrl: string, branch?: string, authUser?: string, authToken?: string, orgId?: string) =>
      fetchJSON<Space>("/api/spaces", {
        method: "POST",
        body: JSON.stringify({ repoUrl, branch, authUser, authToken, orgId }),
      }),
    delete: (id: string) => fetchJSON(`/api/spaces/${id}`, { method: "DELETE" }),
    pull: (id: string) => fetchJSON<{ output: string }>(`/api/spaces/${id}/pull`, { method: "POST" }),
    /** SSE stream of git clone progress lines for a freshly cloned space. */
    cloneStream: (id: string) =>
      new EventSource(`/api/spaces/${id}/clone-events${getAuthQuery()}`, { withCredentials: true }),
  },

  sessions: {
    list: (spaceId: string, opts?: { includeArchived?: boolean }) =>
      fetchJSON<Session[]>(`/api/spaces/${spaceId}/sessions${opts?.includeArchived ? "?includeArchived=true" : ""}`),
    get: (id: string) => fetchJSON<Session>(`/api/sessions/${id}`),
    create: (spaceId: string, opts?: { title?: string; model?: string }) =>
      fetchJSON<Session>(`/api/spaces/${spaceId}/sessions`, {
        method: "POST",
        body: JSON.stringify(opts || {}),
      }),
    delete: (id: string) => fetchJSON(`/api/sessions/${id}`, { method: "DELETE" }),
    archive: (id: string, archived = true) =>
      fetchJSON<Session>(`/api/sessions/${id}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived }),
      }),
    patch: (id: string, updates: Partial<Session>) =>
      fetchJSON<Session>(`/api/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    /** Switch model on the live agent (RPC set_model) + persist for next spawn. */
    setModel: (id: string, model: string, provider?: string) =>
      fetchJSON<{ ok: boolean; model: string; provider: string; live: boolean }>(`/api/sessions/${id}/model`, {
        method: "POST",
        body: JSON.stringify({ model, provider }),
      }),
    getGoal: (id: string) => fetchJSON<{ goal: GoalStatus | null }>(`/api/sessions/${id}/goal`),
    getMessages: (id: string) => fetchJSON<ChatMessage[]>(`/api/sessions/${id}/messages`),
  },

  /** Resolve pretty-URL short ids to full records (used for deep links). */
  resolve: (spaceShort: string, sessionShort?: string) =>
    fetchJSON<{
      space: Space;
      session: Session | null;
      spaceSlug: string;
      sessionSlug: string | null;
    }>(`/api/resolve?space=${encodeURIComponent(spaceShort)}${sessionShort ? `&session=${encodeURIComponent(sessionShort)}` : ""}`),

  sendMessage: (sessionId: string, prompt: string, isGoal: boolean) => {
    return new EventSource(
      `/api/sessions/${sessionId}/message?prompt=${encodeURIComponent(prompt)}&isGoal=${isGoal}`,
      { withCredentials: true }
    );
  },

  sendMessagePOST: async (sessionId: string, prompt: string, mode: ComposerMode) => {
    return fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ prompt, mode, isGoal: mode === "goal" }),
    });
  },

  settings: {
    get: () => fetchJSON<Record<string, string>>("/api/settings"),
    patch: (settings: Record<string, string>) =>
      fetchJSON("/api/settings", { method: "PATCH", body: JSON.stringify(settings) }),
  },

  hammersmith: {
    capability: () => fetchJSON<HammersmithCapability>("/api/hammersmith/capability"),
    settings: () => fetchJSON<HammersmithSettings>("/api/hammersmith/settings"),
    saveSettings: (settings: Partial<HammersmithSettings>) =>
      fetchJSON<HammersmithSettings>("/api/hammersmith/settings", { method: "PATCH", body: JSON.stringify(settings) }),
    jobs: (sessionId: string) => fetchJSON<HammersmithRun[]>(`/api/sessions/${sessionId}/hammersmith/jobs`),
    job: (jobId: string) => fetchJSON<HammersmithRun>(`/api/hammersmith/jobs/${jobId}`),
    stop: (jobId: string) => fetchJSON<{ ok: boolean; stopped: boolean }>(`/api/hammersmith/jobs/${jobId}/stop`, { method: "POST" }),
  },

  git: {
    status: (spaceId: string) => fetchJSON<GitSnapshot>(`/api/spaces/${spaceId}/git`),
    /** Live SSE stream — pushes a snapshot whenever the tree changes. */
    stream: (spaceId: string) =>
      new EventSource(`/api/spaces/${spaceId}/git/sse${getAuthQuery()}`, {
        withCredentials: true,
      }),
    diff: (spaceId: string, path: string) =>
      fetchJSON<{ path: string; diff: string }>(
        `/api/spaces/${spaceId}/git/diff?path=${encodeURIComponent(path)}`
      ),
    commit: (spaceId: string, body: { files: string[]; summary: string; description?: string }) =>
      fetchJSON<{ ok: boolean; data: GitSnapshot }>(`/api/spaces/${spaceId}/git/commit`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    discardFile: (spaceId: string, path: string) =>
      fetchJSON<{ ok: boolean; data: GitSnapshot }>(`/api/spaces/${spaceId}/git/discard-file`, {
        method: "POST",
        body: JSON.stringify({ path, confirmation: "DISCARD TRACKED FILE" }),
      }),
    discardAll: (spaceId: string) =>
      fetchJSON<{ ok: boolean; data: GitSnapshot }>(`/api/spaces/${spaceId}/git/discard-all`, {
        method: "POST",
        body: JSON.stringify({ confirmation: "DISCARD ALL TRACKED CHANGES" }),
      }),
    switchBranch: (spaceId: string, body: { branchName: string; mode: "stash" | "carry" | "clean" }) =>
      fetchJSON<{ ok: boolean; data: GitSnapshot }>(`/api/spaces/${spaceId}/git/switch-branch`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    createBranch: (spaceId: string, body: { branchName: string; baseBranch?: string }) =>
      fetchJSON<{ ok: boolean; data: GitSnapshot }>(`/api/spaces/${spaceId}/git/create-branch`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    pull: (spaceId: string, mode: "ff-only" | "merge" | "rebase" = "ff-only") =>
      fetchJSON<{ ok: boolean; mode: string; output: string; aborted?: boolean; conflicts?: string[]; data: GitSnapshot }>(
        `/api/spaces/${spaceId}/git/pull`,
        { method: "POST", body: JSON.stringify({ mode }) }
      ),
    push: (spaceId: string, setUpstream = false) =>
      fetchJSON<{ ok: boolean; pushed: boolean; data: GitSnapshot }>(
        `/api/spaces/${spaceId}/git/push`,
        { method: "POST", body: JSON.stringify({ setUpstream }) }
      ),
    merge: (spaceId: string, branchName: string) =>
      fetchJSON<{ ok: boolean; merged?: string; aborted?: boolean; conflicts?: string[]; data: GitSnapshot }>(
        `/api/spaces/${spaceId}/git/merge`,
        { method: "POST", body: JSON.stringify({ branchName }) }
      ),
  },
  files: {
    read: (spaceId: string, path: string) =>
      fetchJSON<{ type: "file"; path: string; content: string; revision: string }>(
        `/api/spaces/${spaceId}/files?path=${encodeURIComponent(path)}`
      ),
    write: (spaceId: string, path: string, content: string, revision: string) =>
      fetchJSON<{ ok: true; revision: string }>(`/api/spaces/${spaceId}/files`, {
        method: "PUT",
        body: JSON.stringify({ path, content, revision }),
      }),
  },
};
