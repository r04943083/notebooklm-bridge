// Thin fetch wrapper. Modeled on cpp_rename/frontend/src/api/client.ts but with
// X-User-Id + X-Shared-Secret headers (not X-Username) and localStorage (not
// sessionStorage) so the user identity survives across tab closes.

import type {
  ChatRequest,
  ChatResponse,
  HealthResponse,
  Notebook,
  Source,
} from "./types";

const API_BASE = "/api";

const SHARED_SECRET =
  (import.meta.env.VITE_SHARED_SECRET as string | undefined) ?? "";

export function getUserId(): string {
  return localStorage.getItem("nblm_user_id") ?? "";
}

export function setUserId(v: string): void {
  localStorage.setItem("nblm_user_id", v);
}

function authHeaders(): Record<string, string> {
  const u = getUserId();
  const h: Record<string, string> = {};
  if (u) h["X-User-Id"] = u;
  if (SHARED_SECRET) h["X-Shared-Secret"] = SHARED_SECRET;
  return h;
}

async function request<T>(path: string, opt?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opt?.headers ?? {}),
    },
    ...opt,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listNotebooks: () => request<Notebook[]>("/notebooks"),

  listSources: (notebook_id: string) =>
    request<Source[]>(
      `/sources?notebook_id=${encodeURIComponent(notebook_id)}`
    ),

  ask: (req: ChatRequest) =>
    request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  resetChat: async (notebook_id: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/chat/reset?notebook_id=${encodeURIComponent(notebook_id)}`,
      { method: "POST", headers: authHeaders() }
    );
    if (!res.ok && res.status !== 204) {
      throw new Error(`API ${res.status}: ${await res.text()}`);
    }
  },

  health: () => request<HealthResponse>("/healthz"),
};
