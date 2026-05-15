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
