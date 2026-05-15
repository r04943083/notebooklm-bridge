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


class ChatResponse(BaseModel):
    answer: str
    citations: list[Citation]
    conversation_id: str
    turn: int


class Notebook(BaseModel):
    id: str
    title: str
    updated_at: str | None = None


class Source(BaseModel):
    id: str
    title: str
    kind: str | None = None


class HealthResponse(BaseModel):
    auth_valid: bool
    last_refresh_ts: float | None
    last_rpc_ts: float | None
    inflight_asks: int
    circuit_open: bool
    notebooklm_py_version: str
