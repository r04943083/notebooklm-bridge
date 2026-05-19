"""Tests for POST /api/chat/select — points the (user, notebook) session at a
different conversation_id without making any upstream call.
"""

from __future__ import annotations

from typing import Any

from httpx import AsyncClient

SELECT_URL = "/api/chat/select"
HDR = {"X-User-Id": "alice"}


async def test_happy_path_writes_to_store(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    store = app_with_fake_client.state.store
    assert store.get_session("alice", "nb-1") is None

    resp = await client.post(
        SELECT_URL,
        headers=HDR,
        params={"notebook_id": "nb-1", "conversation_id": "cid-restored"},
    )
    assert resp.status_code == 204
    assert resp.text == ""
    assert store.get_session("alice", "nb-1") == "cid-restored"


async def test_missing_conversation_id_returns_400(client: AsyncClient) -> None:
    """Empty string conversation_id is rejected with our own 400 (not 422),
    so the message is human-readable in the UI."""
    resp = await client.post(
        SELECT_URL,
        headers=HDR,
        params={"notebook_id": "nb-1", "conversation_id": ""},
    )
    assert resp.status_code == 400
    assert "conversation_id" in resp.json()["detail"]


async def test_missing_user_id_returns_401_or_422(client: AsyncClient) -> None:
    resp = await client.post(
        SELECT_URL,
        params={"notebook_id": "nb-1", "conversation_id": "cid"},
    )
    # Either missing header → 422 or auth-rejected → 401, both acceptable.
    assert resp.status_code in (401, 422)


async def test_each_user_has_isolated_session(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """Alice's select must not bleed into Bob's session view."""
    store = app_with_fake_client.state.store

    await client.post(
        SELECT_URL,
        headers={"X-User-Id": "alice"},
        params={"notebook_id": "nb-1", "conversation_id": "alice-cid"},
    )
    await client.post(
        SELECT_URL,
        headers={"X-User-Id": "bob"},
        params={"notebook_id": "nb-1", "conversation_id": "bob-cid"},
    )

    assert store.get_session("alice", "nb-1") == "alice-cid"
    assert store.get_session("bob", "nb-1") == "bob-cid"


async def test_no_upstream_call_made(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """The select endpoint is purely a setter — it must not touch the upstream
    client. Confirm by counting chat.ask + sources.get_fulltext calls."""
    chat_obj = app_with_fake_client.state.client.chat
    sources_ns = app_with_fake_client.state.client.sources
    pre_chat = len(chat_obj.call_log)
    pre_fulltext = len(sources_ns.fulltext_calls)

    resp = await client.post(
        SELECT_URL,
        headers=HDR,
        params={"notebook_id": "nb-1", "conversation_id": "cid"},
    )
    assert resp.status_code == 204
    assert len(chat_obj.call_log) == pre_chat
    assert len(sources_ns.fulltext_calls) == pre_fulltext
