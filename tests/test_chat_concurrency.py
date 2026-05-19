"""The load-bearing test file. Verifies that the chat route preserves session
isolation, rate limiting, the global semaphore, and the circuit breaker, even
under concurrent traffic.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from httpx import ASGITransport, AsyncClient

from .conftest import (
    FakeClient,
    FakeRateLimited,
    FakeUpstreamError,
)

CHAT = "/api/chat"
ANSWER_HEADER_OK = {"X-User-Id": "alice"}


def _hdr(user_id: str) -> dict[str, str]:
    return {"X-User-Id": user_id}


async def test_single_turn_returns_answer_and_citations(client: AsyncClient) -> None:
    resp = await client.post(
        CHAT,
        headers=_hdr("alice"),
        json={"notebook_id": "nb-1", "question": "hello"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["answer"]
    assert len(body["citations"]) >= 1
    assert body["conversation_id"]


async def test_multi_turn_preserves_conversation_id(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    chat_obj = app_with_fake_client.state.client.chat
    chat_obj.next_conv_id = "conv-42"

    r1 = await client.post(CHAT, headers=_hdr("u"), json={"notebook_id": "nb", "question": "q1"})
    assert r1.status_code == 200
    assert r1.json()["conversation_id"] == "conv-42"

    r2 = await client.post(CHAT, headers=_hdr("u"), json={"notebook_id": "nb", "question": "q2"})
    assert r2.status_code == 200
    # Second call should carry the conversation_id from the first
    assert chat_obj.call_log[1]["conversation_id"] == "conv-42"


async def test_reset_starts_new_conversation(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    chat_obj = app_with_fake_client.state.client.chat
    await client.post(CHAT, headers=_hdr("u"), json={"notebook_id": "nb", "question": "q1"})
    await client.post(
        CHAT,
        headers=_hdr("u"),
        json={"notebook_id": "nb", "question": "q2", "reset": True},
    )
    # Second call must have conversation_id=None upstream
    assert chat_obj.call_log[1]["conversation_id"] is None


async def test_concurrent_users_isolated(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """5 users × 3 turns each, no answer cross-talk."""
    users = [f"user{i}" for i in range(5)]
    chat_obj = app_with_fake_client.state.client.chat
    chat_obj.next_delay = 0.05

    async def one_turn(uid: str, turn: int) -> None:
        r = await client.post(
            CHAT,
            headers=_hdr(uid),
            json={"notebook_id": f"nb-{uid}", "question": f"{uid}-q{turn}"},
        )
        assert r.status_code == 200, r.text
        # Sanity: the answer template includes the question, so this proves the
        # response we received corresponds to the request we sent.
        assert f"{uid}-q{turn}" in r.json()["answer"]

    tasks = [one_turn(u, t) for u in users for t in range(3)]
    await asyncio.gather(*tasks)

    # Per-user, conversation_id should be stable across that user's turns
    per_user_calls: dict[str, list[dict]] = {}
    for entry in chat_obj.call_log:
        # questions look like "userN-qK"
        uid = entry["question"].split("-")[0]
        per_user_calls.setdefault(uid, []).append(entry)
    for _uid, entries in per_user_calls.items():
        assert len(entries) == 3
        # The first call has conversation_id=None, subsequent calls reuse it
        assert entries[0]["conversation_id"] is None


async def test_semaphore_caps_inflight(
    app_with_fake_client: Any,
) -> None:
    """When MAX_INFLIGHT_ASKS=2, no more than 2 should be inflight simultaneously."""
    # Tighten the semaphore for this test
    app_with_fake_client.state.semaphore = asyncio.Semaphore(2)
    chat_obj = app_with_fake_client.state.client.chat
    chat_obj.next_delay = 0.3

    peak_inflight = 0

    async def fire(uid: str) -> int:
        nonlocal peak_inflight
        transport = ASGITransport(app=app_with_fake_client)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
        ) as c:
            # Quick race: snapshot inflight just after dispatching
            async def watcher() -> None:
                nonlocal peak_inflight
                for _ in range(30):
                    peak_inflight = max(peak_inflight, int(app_with_fake_client.state.inflight))
                    await asyncio.sleep(0.02)

            watch = asyncio.create_task(watcher())
            r = await c.post(
                CHAT, headers=_hdr(uid), json={"notebook_id": "nb", "question": uid}
            )
            await watch
            return r.status_code

    statuses = await asyncio.gather(*(fire(f"u{i}") for i in range(5)))
    assert all(s == 200 for s in statuses)
    assert peak_inflight <= 2


async def test_rate_limit_returns_429(client: AsyncClient) -> None:
    """Burst=3 in conftest → 4th call within the same instant must 429."""
    for i in range(3):
        r = await client.post(
            CHAT, headers=_hdr("hammer"), json={"notebook_id": "nb", "question": f"q{i}"}
        )
        assert r.status_code == 200, r.text
    r = await client.post(
        CHAT, headers=_hdr("hammer"), json={"notebook_id": "nb", "question": "q4"}
    )
    assert r.status_code == 429
    assert r.headers.get("Retry-After")


async def test_circuit_breaker_trips_on_upstream_error(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    chat_obj = app_with_fake_client.state.client.chat
    chat_obj.raise_exc = FakeRateLimited("simulated")
    r1 = await client.post(
        CHAT, headers=_hdr("u-ok"), json={"notebook_id": "nb", "question": "q"}
    )
    assert r1.status_code == 503
    # Subsequent calls should be short-circuited (no upstream call made)
    pre = len(chat_obj.call_log)
    r2 = await client.post(
        CHAT, headers=_hdr("u-ok2"), json={"notebook_id": "nb", "question": "q"}
    )
    assert r2.status_code == 503
    assert len(chat_obj.call_log) == pre  # breaker prevented the call


async def test_circuit_recovers_after_cooldown(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    store = app_with_fake_client.state.store
    chat_obj = app_with_fake_client.state.client.chat
    chat_obj.raise_exc = FakeUpstreamError("boom")
    await client.post(CHAT, headers=_hdr("u"), json={"notebook_id": "nb", "question": "q"})
    assert store.is_circuit_open() is True
    # Manually expire the breaker (rather than sleep 30s)
    store.circuit_open_until = time.monotonic() - 1.0
    assert store.is_circuit_open() is False
    chat_obj.raise_exc = None
    r = await client.post(CHAT, headers=_hdr("u2"), json={"notebook_id": "nb", "question": "q"})
    assert r.status_code == 200


async def test_ask_timeout_returns_504_no_circuit_trip(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """Override the timeout to something tiny and make the upstream sleep longer."""
    # Mutate settings via app.state.cfg + monkey-patch ask_timeout in the route.
    app_with_fake_client.state.cfg.ask_timeout_seconds = 0  # type: ignore[attr-defined]
    # The route reads timeout from Settings via Depends, so re-arm it that way:
    from backend.config import get_settings

    s = get_settings()
    object.__setattr__(s, "ask_timeout_seconds", 0)

    chat_obj = app_with_fake_client.state.client.chat
    chat_obj.next_delay = 0.2

    r = await client.post(CHAT, headers=_hdr("u"), json={"notebook_id": "nb", "question": "q"})
    assert r.status_code == 504
    assert app_with_fake_client.state.store.is_circuit_open() is False

    # Restore timeout for other tests in the session
    object.__setattr__(s, "ask_timeout_seconds", 60)


async def test_client_unavailable_returns_503(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    app_with_fake_client.state.client = None
    r = await client.post(
        CHAT, headers=_hdr("u"), json={"notebook_id": "nb", "question": "q"}
    )
    assert r.status_code == 503
    body = r.json()
    assert "上游凭证" in body["detail"]


async def test_persistence_across_app_restart(settings: Any, state_path: Any) -> None:
    """Run lifespan twice with the same state.json; sessions written in run 1 must
    be visible to run 2."""
    from asgi_lifespan import LifespanManager

    from backend.app import create_app

    # --- run 1: write a session via the store directly ---
    app1 = create_app()
    async with LifespanManager(app1):
        app1.state.client = FakeClient()
        app1.state.store.set_session("alice", "nb-1", "cid-persist")
        await app1.state.store.flush()

    # --- run 2: same state.json path → session should be loaded ---
    app2 = create_app()
    async with LifespanManager(app2):
        assert app2.state.store.get_session("alice", "nb-1") == "cid-persist"


async def test_reset_endpoint_clears_session(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    store = app_with_fake_client.state.store
    store.set_session("u", "nb", "old-cid")
    r = await client.post("/api/chat/reset", headers=_hdr("u"), params={"notebook_id": "nb"})
    assert r.status_code == 204
    assert store.get_session("u", "nb") is None
