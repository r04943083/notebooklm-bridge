"""Pydantic models shared between routes, tests, and the frontend type mirror.

If a field is added/removed here, also update ``frontend/src/types.ts`` so the
TypeScript view stays in sync.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    notebook_id: str = Field(min_length=1, max_length=128)
    question: str = Field(min_length=1, max_length=4000)
    source_ids: list[str] | None = None
    reset: bool = False


class Citation(BaseModel):
    source_id: str
    source_title: str
    text: str
    page: int | None = None
    # Offsets in NotebookLM's internal chunked index. NOT positions in the
    # source full text — surfaced for debugging only. See upstream
    # SourceFulltext.find_citation_context docstring.
    start_char: int | None = None
    end_char: int | None = None


class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]
    conversation_id: str
    turn: int


class Notebook(BaseModel):
    id: str
    title: str
    created_at: str | None = None
    sources_count: int | None = None


class Source(BaseModel):
    id: str
    title: str
    kind: str | None = None
    # Web / YouTube sources expose their original URL; PDFs / Drive files do not.
    url: str | None = None
    created_at: str | None = None
    # Mapped from upstream int code: 1=processing, 2=ready, 3=error.
    status: str | None = None


class SourceFulltext(BaseModel):
    source_id: str
    title: str | None = None
    kind: str | None = None
    url: str | None = None
    content: str
    char_count: int


class HealthResponse(BaseModel):
    auth_valid: bool
    last_refresh_ts: float | None
    last_rpc_ts: float | None
    inflight_asks: int
    circuit_open: bool
    notebooklm_py_version: str
