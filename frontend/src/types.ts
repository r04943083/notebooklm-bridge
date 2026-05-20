// Mirror of backend/schemas.py — keep in sync when adding/removing fields.

export interface ChatRequest {
  notebook_id: string;
  question: string;
  source_ids?: string[] | null;
  reset?: boolean;
}

export interface Citation {
  source_id: string;
  source_title: string;
  text: string;
  page?: number | null;
  // Offsets in NotebookLM's internal chunked index, NOT positions in the
  // source full text. Surfaced for debugging; the fulltext viewer uses a
  // substring search on `text` instead.
  start_char?: number | null;
  end_char?: number | null;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  conversation_id: string;
  turn: number;
}

export interface Notebook {
  id: string;
  title: string;
  created_at?: string | null;
  sources_count?: number | null;
}

export interface Source {
  id: string;
  title: string;
  kind?: string | null;
  // Web / YouTube sources expose their original URL; PDFs / Drive do not.
  url?: string | null;
  created_at?: string | null;
  // "processing" | "ready" | "error" (mirror of upstream int code 1/2/3).
  status?: string | null;
}

export interface SourceFulltext {
  source_id: string;
  title?: string | null;
  kind?: string | null;
  url?: string | null;
  content: string;
  char_count: number;
}

export interface HealthResponse {
  auth_valid: boolean;
  last_refresh_ts: number | null;
  last_rpc_ts: number | null;
  inflight_asks: number;
  circuit_open: boolean;
  notebooklm_py_version: string;
}

export interface ChatTurn {
  question: string;
  response: ChatResponse;
}

export interface HistoryEntry {
  notebook_id: string;
  conversation_id: string;
  first_question: string;
  ts: number;
}

// Server-side (no notebook_id — that's a query param on the GET).
export interface ConvMeta {
  conversation_id: string;
  first_question: string;
  ts: number;
}

// Server-side (no conversation_id — that's a path param on the GET).
export interface TurnRecord {
  turn: number;
  question: string;
  answer: string;
  citations: Citation[];
}
