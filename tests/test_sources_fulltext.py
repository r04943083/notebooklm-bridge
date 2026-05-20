"""Tests for GET /api/sources/{source_id}/fulltext.

Mirrors the chat-route safety contracts: client-live check, circuit breaker,
timeout maps to 504 *without* tripping the breaker, upstream errors map to 503
*and* trip the breaker.
"""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient

from .conftest import FakeUpstreamError

FULLTEXT_URL = "/api/sources/s1/fulltext"
HDR = {"X-User-Id": "alice"}


async def test_happy_path_returns_content_and_metadata(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    sources_ns = app_with_fake_client.state.client.sources
    sources_ns.fulltext_content = "First sentence. Second sentence."
    sources_ns.fulltext_title = "Doc 1"
    sources_ns.fulltext_kind = "pdf"

    resp = await client.get(FULLTEXT_URL, headers=HDR, params={"notebook_id": "nb-1"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source_id"] == "s1"
    assert body["title"] == "Doc 1"
    assert body["kind"] == "pdf"
    assert body["content"] == "First sentence. Second sentence."
    assert body["char_count"] == len("First sentence. Second sentence.")

    # Upstream was called with the right kwargs
    assert sources_ns.fulltext_calls[-1] == {"notebook_id": "nb-1", "source_id": "s1"}


async def test_missing_notebook_id_returns_422(client: AsyncClient) -> None:
    """notebook_id is a required query parameter — FastAPI rejects with 422."""
    resp = await client.get(FULLTEXT_URL, headers=HDR)
    assert resp.status_code == 422


async def test_missing_user_id_returns_401_or_422(client: AsyncClient) -> None:
    resp = await client.get(FULLTEXT_URL, params={"notebook_id": "nb-1"})
    # Auth dependency rejects with 401 (wrong/missing) or 422 (header validator)
    assert resp.status_code in (401, 422)


async def test_client_unavailable_returns_503(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    app_with_fake_client.state.client = None
    resp = await client.get(FULLTEXT_URL, headers=HDR, params={"notebook_id": "nb-1"})
    assert resp.status_code == 503
    assert "登录凭证" in resp.json()["detail"]


async def test_upstream_error_returns_503_and_trips_circuit(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    store = app_with_fake_client.state.store
    sources_ns = app_with_fake_client.state.client.sources
    sources_ns.next_fulltext_exc = FakeUpstreamError("boom")

    resp = await client.get(FULLTEXT_URL, headers=HDR, params={"notebook_id": "nb-1"})
    assert resp.status_code == 503
    assert store.is_circuit_open() is True

    # Follow-up call is short-circuited (the breaker prevents upstream contact)
    pre_calls = len(sources_ns.fulltext_calls)
    resp2 = await client.get(FULLTEXT_URL, headers=HDR, params={"notebook_id": "nb-1"})
    assert resp2.status_code == 503
    assert len(sources_ns.fulltext_calls) == pre_calls


async def test_timeout_returns_504_without_tripping_circuit(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """ask_timeout=0 forces wait_for to fire immediately; circuit stays closed."""
    from backend.config import get_settings

    s = get_settings()
    object.__setattr__(s, "ask_timeout_seconds", 0)
    sources_ns = app_with_fake_client.state.client.sources
    sources_ns.next_fulltext_delay = 0.2

    try:
        resp = await client.get(FULLTEXT_URL, headers=HDR, params={"notebook_id": "nb-1"})
        assert resp.status_code == 504
        assert app_with_fake_client.state.store.is_circuit_open() is False
    finally:
        # Restore so subsequent tests aren't poisoned
        object.__setattr__(s, "ask_timeout_seconds", 60)
