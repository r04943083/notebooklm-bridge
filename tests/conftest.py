"""Shared pytest fixtures.

We don't depend on notebooklm-py during testing — instead, a ``FakeClient`` /
``FakeChat`` pair satisfies the structural protocol declared in
:mod:`backend._notebooklm_protocol`. Tests that need the FastAPI app injected
with the fake use the ``app_with_fake_client`` fixture; tests for ``Store`` /
``auth`` are pure-Python and don't need the full app.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from backend.config import get_settings


@pytest.fixture
def state_path(tmp_path: Path) -> Path:
    return tmp_path / "state.json"


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch, state_path: Path) -> Any:
    """Reset Settings cache and inject test-safe env values for every test."""
    monkeypatch.setenv("NOTEBOOKLM_AUTH_JSON", "/dev/null")
    monkeypatch.setenv("STATE_JSON", str(state_path))
    monkeypatch.setenv("INTERNAL_FRONTEND_ORIGIN", "http://test")
    monkeypatch.setenv("BACKEND_PORT", "8002")
    monkeypatch.setenv("MAX_INFLIGHT_ASKS", "8")
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "10")
    monkeypatch.setenv("RATE_LIMIT_BURST", "3")
    monkeypatch.setenv("CIRCUIT_BREAKER_COOLDOWN", "30")
    monkeypatch.setenv("ASK_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("ALLOWED_NOTEBOOK_IDS", "")
    get_settings.cache_clear()
    return get_settings()


# ---------------------------------------------------------------------------
# Fake upstream client
# ---------------------------------------------------------------------------
@dataclass
class FakeAskResult:
    answer: str
    citations: list[dict]
    conversation_id: str
    turn: int


@dataclass
class FakeChat:
    """Drop-in replacement for ``client.chat``. Configurable per-test:

    * ``next_delay``  — async-sleep before returning (used to test semaphore queueing)
    * ``raise_exc``   — exception instance to raise next call (cleared after use)
    * ``call_log``    — every ask() call's kwargs, for cross-talk assertions
    """

    next_delay: float = 0.0
    raise_exc: BaseException | None = None
    next_conv_id: str = "conv-1"
    answer_template: str = "answer to {question}"
    call_log: list[dict] = field(default_factory=list)

    async def ask(
        self,
        *,
        notebook_id: str,
        question: str,
        source_ids: list[str] | None = None,
        conversation_id: str | None = None,
    ) -> FakeAskResult:
        self.call_log.append(
            {
                "notebook_id": notebook_id,
                "question": question,
                "source_ids": source_ids,
                "conversation_id": conversation_id,
            }
        )
        if self.next_delay > 0:
            await asyncio.sleep(self.next_delay)
        if self.raise_exc is not None:
            exc = self.raise_exc
            self.raise_exc = None
            raise exc
        cid = conversation_id or self.next_conv_id
        return FakeAskResult(
            answer=self.answer_template.format(question=question, notebook=notebook_id),
            citations=[
                {"source_id": "s1", "source_title": "Doc 1", "text": question[:20], "page": 1}
            ],
            conversation_id=cid,
            turn=1,
        )


class FakeClient:
    def __init__(self) -> None:
        self.chat = FakeChat()

        async def _list_nb() -> list[Any]:
            return [SimpleNamespace(id="nb-1", title="Notebook 1", updated_at=None)]

        async def _list_src(notebook_id: str) -> list[Any]:
            # Mirror notebooklm-py 0.4.x Source surface so the new mapping
            # branches in _list_sources (url / created_at / status) get
            # exercised even though no test asserts on the values directly.
            return [
                SimpleNamespace(
                    id="s1",
                    title="Source 1",
                    kind="pdf",
                    url=None,
                    created_at=None,
                    status=2,  # ready
                ),
                SimpleNamespace(
                    id="s2",
                    title="A web link",
                    kind="web_page",
                    url="https://example.com",
                    created_at=None,
                    status=2,
                ),
            ]

        # Per-test knobs for sources.get_fulltext, exposed on the namespace so
        # tests can poke them after fixture setup (mirrors the FakeChat pattern).
        sources_ns = SimpleNamespace()
        sources_ns.next_fulltext_delay = 0.0
        sources_ns.next_fulltext_exc = None
        sources_ns.fulltext_title = "Source 1"
        sources_ns.fulltext_kind = "pdf"
        sources_ns.fulltext_url = None
        sources_ns.fulltext_content = "Hello world, this is the fulltext."
        sources_ns.fulltext_calls: list[dict[str, str]] = []

        async def _get_fulltext(notebook_id: str, source_id: str) -> Any:
            sources_ns.fulltext_calls.append(
                {"notebook_id": notebook_id, "source_id": source_id}
            )
            if sources_ns.next_fulltext_delay > 0:
                await asyncio.sleep(sources_ns.next_fulltext_delay)
            if sources_ns.next_fulltext_exc is not None:
                exc = sources_ns.next_fulltext_exc
                sources_ns.next_fulltext_exc = None
                raise exc
            return SimpleNamespace(
                source_id=source_id,
                title=sources_ns.fulltext_title,
                content=sources_ns.fulltext_content,
                kind=sources_ns.fulltext_kind,
                url=sources_ns.fulltext_url,
                char_count=len(sources_ns.fulltext_content),
            )

        sources_ns.list = _list_src
        sources_ns.get_fulltext = _get_fulltext

        self.notebooks = SimpleNamespace(list=_list_nb)
        self.sources = sources_ns

    async def close(self) -> None:  # pragma: no cover - trivial
        return None


# ---------------------------------------------------------------------------
# App + transport fixtures
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def app_with_fake_client(settings: Any) -> AsyncIterator[Any]:
    """Build the real FastAPI app, run lifespan (which will leave client=None
    because notebooklm-py isn't installed in tests), then swap in a FakeClient.
    """
    from backend.app import create_app

    application = create_app()
    async with LifespanManager(application):
        fake = FakeClient()
        application.state.client = fake
        application.state.auth_valid = True
        # Configure upstream_exceptions to a tuple that some tests can raise.
        application.state.upstream_exceptions = (
            FakeRateLimited,
            FakeUpstreamError,
            FakeAuthExpired,
        )
        yield application


@pytest_asyncio.fixture
async def client(app_with_fake_client: Any) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app_with_fake_client)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# Synthetic upstream exception classes (stand-ins for notebooklm.errors.*)
# ---------------------------------------------------------------------------
class FakeRateLimited(Exception):
    pass


class FakeUpstreamError(Exception):
    pass


class FakeAuthExpired(Exception):
    pass


# AuthExpired matches by name inside chat.py, so this stand-in must be called
# exactly "AuthExpired" for that branch. Provide an alias the test can import.
AuthExpired = type("AuthExpired", (FakeAuthExpired,), {})
