// Thin fetch wrapper. Modeled on cpp_rename/frontend/src/api/client.ts but with
// X-User-Id + X-Shared-Secret headers (not X-Username) and localStorage (not
// sessionStorage) so the user identity survives across tab closes.

import type {
  ChatRequest,
  ChatResponse,
  HealthResponse,
  Notebook,
  Source,
  SourceFulltext,
} from "./types";

/**
 * Surfaces the HTTP status so callers can branch on it (e.g. retry only on
 * 503/504). Existing call sites that read `.message` keep working — ApiError
 * extends Error.
 *
 * The status field is declared explicitly rather than as a TS parameter
 * property because tsconfig has `erasableSyntaxOnly` enabled.
 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

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
    throw new ApiError(res.status, `API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

interface AskOptions {
  signal?: AbortSignal;
}

export const api = {
  listNotebooks: () => request<Notebook[]>("/notebooks"),

  listSources: (notebook_id: string) =>
    request<Source[]>(
      `/sources?notebook_id=${encodeURIComponent(notebook_id)}`
    ),

  getSourceFulltext: (notebook_id: string, source_id: string) =>
    request<SourceFulltext>(
      `/sources/${encodeURIComponent(source_id)}/fulltext?notebook_id=${encodeURIComponent(notebook_id)}`
    ),

  ask: (req: ChatRequest, opts?: AskOptions) =>
    request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify(req),
      signal: opts?.signal,
    }),

  resetChat: async (notebook_id: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/chat/reset?notebook_id=${encodeURIComponent(notebook_id)}`,
      { method: "POST", headers: authHeaders() }
    );
    if (!res.ok && res.status !== 204) {
      throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    }
  },

  selectConversation: async (
    notebook_id: string,
    conversation_id: string
  ): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/chat/select?notebook_id=${encodeURIComponent(notebook_id)}&conversation_id=${encodeURIComponent(conversation_id)}`,
      { method: "POST", headers: authHeaders() }
    );
    if (!res.ok && res.status !== 204) {
      throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    }
  },

  health: () => request<HealthResponse>("/healthz"),
};
