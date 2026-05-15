"""Structural types describing the slice of notebooklm-py that the bridge uses.

We don't import notebooklm-py here — it's not pinned yet, may not be installed
during skeleton development, and might rename symbols across versions. Protocols
let mypy typecheck callers, and let test FakeClients be drop-in via structural
subtyping (no abstract base inheritance).

When Phase 1 pins notebooklm-py and these names drift, update this module to
match. Production code only ever calls into the surface declared here.
"""

from __future__ import annotations

from typing import Any, Protocol


class AskResult(Protocol):
    answer: str
    citations: Any  # narrow once notebooklm-py is pinned and its citation type is known
    conversation_id: str
    turn: int


class ChatLike(Protocol):
    async def ask(
        self,
        *,
        notebook_id: str,
        question: str,
        source_ids: list[str] | None = None,
        conversation_id: str | None = None,
    ) -> AskResult: ...


class NotebookListItem(Protocol):
    id: str
    title: str


class NotebooksLike(Protocol):
    async def list(self) -> list[NotebookListItem]: ...


class SourceListItem(Protocol):
    id: str
    title: str


class SourcesLike(Protocol):
    async def list(self, notebook_id: str) -> list[SourceListItem]: ...


class NotebookLMClientLike(Protocol):
    chat: ChatLike
    notebooks: NotebooksLike
    sources: SourcesLike

    async def close(self) -> None: ...
