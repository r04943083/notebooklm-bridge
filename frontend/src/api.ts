// Thin fetch wrapper. Modeled on cpp_rename/frontend/src/api/client.ts but with
// an X-User-Id header (not X-Username) and localStorage (not sessionStorage) so
// the user identity survives across tab closes. The X-Shared-Secret header was
// removed in v1.0.3 — see backend/auth.py for the rationale.

import type {
  ChatRequest,
  ChatResponse,
  ConvMeta,
  HealthResponse,
  HistoryEntry,
  Notebook,
  Source,
  SourceFulltext,
  TurnRecord,
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

// FastAPI HTTPException(detail=...) serializes to {"detail": "..."} — surface
// just that string to the user instead of the full JSON body, so error
// messages like the "凭证已失效,请联系管理员重新登录" guidance show up
// cleanly without "API 503: {\"detail\":...}" wrapping. Non-JSON / non-detail
// responses fall back to the raw text so we don't swallow useful info.
async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // not JSON — fall through
  }
  return text || `HTTP ${res.status}`;
}

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
    throw new ApiError(res.status, await readErrorMessage(res));
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
      throw new ApiError(res.status, await readErrorMessage(res));
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
      throw new ApiError(res.status, await readErrorMessage(res));
    }
  },

  // History was moved from browser localStorage to the bridge backend so the
  // same X-User-Id sees the same conversation log from any browser. The wire
  // shape is ConvMeta (no notebook_id); we patch the notebook_id back on for
  // the caller so App.tsx's existing HistoryEntry-shaped state stays unchanged.
  getHistory: async (notebook_id: string): Promise<HistoryEntry[]> => {
    const metas = await request<ConvMeta[]>(
      `/history?notebook_id=${encodeURIComponent(notebook_id)}`
    );
    return metas.map((m) => ({
      notebook_id,
      conversation_id: m.conversation_id,
      first_question: m.first_question,
      ts: m.ts,
    }));
  },

  getTurns: (conversation_id: string) =>
    request<TurnRecord[]>(
      `/history/${encodeURIComponent(conversation_id)}/turns`
    ),

  clearHistory: async (notebook_id: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/history?notebook_id=${encodeURIComponent(notebook_id)}`,
      { method: "DELETE", headers: authHeaders() }
    );
    if (!res.ok && res.status !== 204) {
      throw new ApiError(res.status, await readErrorMessage(res));
    }
  },

  health: () => request<HealthResponse>("/healthz"),
};
