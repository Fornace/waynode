import type { User, Space, Session, GoalStatus, ChatMessage } from "../types";

const base = "";

const DEV_TOKEN = localStorage.getItem("waynode-dev-token") || "";

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(base + url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(DEV_TOKEN ? { "x-dev-token": DEV_TOKEN } : {}),
    },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  auth: {
    me: () => fetchJSON<{ user: User | null }>("/api/auth/me"),
    logout: () => fetchJSON("/auth/logout", { method: "POST" }),
  },

  spaces: {
    list: () => fetchJSON<Space[]>("/api/spaces"),
    get: (id: string) => fetchJSON<Space>(`/api/spaces/${id}`),
    create: (repoUrl: string, branch?: string) =>
      fetchJSON<Space>("/api/spaces", {
        method: "POST",
        body: JSON.stringify({ repoUrl, branch }),
      }),
    delete: (id: string) => fetchJSON(`/api/spaces/${id}`, { method: "DELETE" }),
    pull: (id: string) => fetchJSON<{ output: string }>(`/api/spaces/${id}/pull`, { method: "POST" }),
  },

  sessions: {
    list: (spaceId: string) => fetchJSON<Session[]>(`/api/spaces/${spaceId}/sessions`),
    get: (id: string) => fetchJSON<Session>(`/api/sessions/${id}`),
    create: (spaceId: string, opts?: { title?: string; model?: string }) =>
      fetchJSON<Session>(`/api/spaces/${spaceId}/sessions`, {
        method: "POST",
        body: JSON.stringify(opts || {}),
      }),
    delete: (id: string) => fetchJSON(`/api/sessions/${id}`, { method: "DELETE" }),
    patch: (id: string, updates: Partial<Session>) =>
      fetchJSON<Session>(`/api/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    getGoal: (id: string) => fetchJSON<{ goal: GoalStatus | null }>(`/api/sessions/${id}/goal`),
    getMessages: (id: string) => fetchJSON<ChatMessage[]>(`/api/sessions/${id}/messages`),
  },

  sendMessage: (sessionId: string, prompt: string, isGoal: boolean) => {
    return new EventSource(
      `/api/sessions/${sessionId}/message?prompt=${encodeURIComponent(prompt)}&isGoal=${isGoal}`,
      { withCredentials: true }
    );
  },

  sendMessagePOST: async (sessionId: string, prompt: string, isGoal: boolean) => {
    return fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(DEV_TOKEN ? { "x-dev-token": DEV_TOKEN } : {}),
      },
      body: JSON.stringify({ prompt, isGoal }),
    });
  },

  settings: {
    get: () => fetchJSON<Record<string, string>>("/api/settings"),
    patch: (settings: Record<string, string>) =>
      fetchJSON("/api/settings", { method: "PATCH", body: JSON.stringify(settings) }),
  },
};
