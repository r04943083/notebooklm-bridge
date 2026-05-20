"""Tests for GET /api/history, GET /api/history/{cid}/turns, DELETE /api/history.

Writes happen inside POST /api/chat → store.append_turn; these tests drive the
flow end-to-end through ASGI so the auth dep, route handler, and store path are
all exercised. The FakeChat fixture lets us drive distinct conversation_ids per
ask by mutating ``next_conv_id`` before each call.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from httpx import AsyncClient

from backend.store import Store

CHAT_URL = "/api/chat"
RESET_URL = "/api/chat/reset"
HISTORY_URL = "/api/history"
HDR = {"X-User-Id": "alice"}

CFG = SimpleNamespace(
    rate_limit_per_minute=10, rate_limit_burst=3, circuit_breaker_cooldown=30
)


async def _ask(client: AsyncClient, question: str, notebook_id: str = "nb-1") -> dict:
    """POST /api/chat as alice and return the JSON body."""
    resp = await client.post(
        CHAT_URL,
        headers=HDR,
        json={"notebook_id": notebook_id, "question": question, "reset": True},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_post_chat_writes_history_and_turn(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """A single ask populates both the history list and the turns log."""
    app_with_fake_client.state.client.chat.next_conv_id = "cid-1"
    body = await _ask(client, "hello world")
    cid = body["conversation_id"]
    assert cid == "cid-1"

    hist = await client.get(
        HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"}
    )
    assert hist.status_code == 200
    metas = hist.json()
    assert len(metas) == 1
    assert metas[0]["conversation_id"] == cid
    assert metas[0]["first_question"] == "hello world"
    assert metas[0]["ts"] > 0

    turns = await client.get(f"/api/history/{cid}/turns", headers=HDR)
    assert turns.status_code == 200
    trs = turns.json()
    assert len(trs) == 1
    assert trs[0]["question"] == "hello world"
    assert trs[0]["answer"] == body["answer"]
    assert trs[0]["turn"] == body["turn"]
    assert trs[0]["citations"] == body["citations"]


async def test_history_orders_newest_first(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """List endpoint reverses store's tail=newest order so the wire is newest-first."""
    chat = app_with_fake_client.state.client.chat
    for i in range(3):
        chat.next_conv_id = f"cid-{i}"
        await _ask(client, f"q{i}")

    resp = await client.get(HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"})
    metas = resp.json()
    assert [m["conversation_id"] for m in metas] == ["cid-2", "cid-1", "cid-0"]
    timestamps = [m["ts"] for m in metas]
    assert timestamps == sorted(timestamps, reverse=True)


async def test_history_cap_20_drops_oldest(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """Capacity = 20 per (user, notebook); oldest is evicted including its turns.

    Drives the store directly because doing 21 rapid /api/chat calls would trip
    the per-user rate-limiter (burst=3). The cap is a Store invariant; the HTTP
    path is covered by the other tests.
    """
    store = app_with_fake_client.state.store
    for i in range(21):
        store.append_turn(
            user_id="alice",
            notebook_id="nb-1",
            conversation_id=f"cid-{i:02d}",
            question=f"q{i}",
            answer="a",
            citations=[],
            turn_number=1,
        )

    resp = await client.get(HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"})
    metas = resp.json()
    assert len(metas) == 20
    cids = {m["conversation_id"] for m in metas}
    assert "cid-00" not in cids  # oldest dropped
    assert "cid-20" in cids  # newest kept

    assert store.get_turns("alice", "cid-00") == []
    gone = await client.get("/api/history/cid-00/turns", headers=HDR)
    assert gone.status_code == 404


async def test_history_cap_promotes_active_conv(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """Re-asking on cid-00 promotes it to the tail, so cid-01 (now oldest) is dropped.

    Drives the store directly for the same rate-limiter reason as the prior test.
    """
    store = app_with_fake_client.state.store
    for i in range(20):
        store.append_turn(
            user_id="alice",
            notebook_id="nb-1",
            conversation_id=f"cid-{i:02d}",
            question=f"q{i}",
            answer="a",
            citations=[],
            turn_number=1,
        )
    # Promote the oldest by appending another turn to cid-00.
    store.append_turn(
        user_id="alice",
        notebook_id="nb-1",
        conversation_id="cid-00",
        question="follow up",
        answer="a",
        citations=[],
        turn_number=2,
    )
    # Add a 21st distinct conversation — cid-01 (now oldest) should fall off.
    store.append_turn(
        user_id="alice",
        notebook_id="nb-1",
        conversation_id="cid-NEW",
        question="fresh",
        answer="a",
        citations=[],
        turn_number=1,
    )

    resp = await client.get(HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"})
    cids = [m["conversation_id"] for m in resp.json()]
    assert len(cids) == 20
    assert "cid-00" in cids  # promoted, survives
    assert "cid-01" not in cids  # next-oldest dropped
    assert "cid-NEW" in cids


async def test_get_turns_404_for_other_user_cid(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """Bob cannot read alice's cid; an unknown cid is also 404 (no enumeration)."""
    app_with_fake_client.state.client.chat.next_conv_id = "alice-cid"
    body = await _ask(client, "alice's question")
    cid = body["conversation_id"]

    bob = await client.get(
        f"/api/history/{cid}/turns", headers={"X-User-Id": "bob"}
    )
    assert bob.status_code == 404

    unknown = await client.get("/api/history/does-not-exist/turns", headers=HDR)
    assert unknown.status_code == 404


async def test_delete_history_clears_everything(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """DELETE wipes history + turns + the session cid pointer for the notebook."""
    store = app_with_fake_client.state.store
    chat = app_with_fake_client.state.client.chat

    for i, q in enumerate(["q1", "q2"]):
        chat.next_conv_id = f"cid-{i}"
        await _ask(client, q)
    cid0, cid1 = "cid-0", "cid-1"

    resp = await client.get(HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"})
    assert len(resp.json()) == 2
    assert store.get_session("alice", "nb-1") == cid1  # last ask wrote the pointer

    delete = await client.delete(
        HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"}
    )
    assert delete.status_code == 204

    after = await client.get(HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"})
    assert after.json() == []
    for cid in (cid0, cid1):
        gone = await client.get(f"/api/history/{cid}/turns", headers=HDR)
        assert gone.status_code == 404
    assert store.get_session("alice", "nb-1") is None


async def test_state_json_v1_to_v2_load(state_path: Path) -> None:
    """A pre-existing v1 state.json round-trips: sessions survive, histories empty,
    next flush rewrites the file at v=2 with histories/turns dicts present."""
    state_path.write_text(
        json.dumps({"version": 1, "sessions": {"alice|nb-1": "cid-old"}}),
        encoding="utf-8",
    )

    store = Store.load(state_path, CFG)
    assert store.get_session("alice", "nb-1") == "cid-old"
    assert store.histories == {}
    assert store.turns == {}

    store.set_session("alice", "nb-2", "cid-new")
    await store.flush()

    data = json.loads(state_path.read_text(encoding="utf-8"))
    assert data["version"] == 2
    assert "histories" in data
    assert "turns" in data
    assert data["sessions"]["alice|nb-1"] == "cid-old"
    assert data["sessions"]["alice|nb-2"] == "cid-new"


async def test_reset_chat_does_not_clear_history(
    client: AsyncClient, app_with_fake_client: Any
) -> None:
    """POST /api/chat/reset is a session-pointer reset — history must survive."""
    app_with_fake_client.state.client.chat.next_conv_id = "cid-A"
    body = await _ask(client, "first")
    cid = body["conversation_id"]

    resp = await client.post(RESET_URL, headers=HDR, params={"notebook_id": "nb-1"})
    assert resp.status_code == 204

    hist = await client.get(HISTORY_URL, headers=HDR, params={"notebook_id": "nb-1"})
    metas = hist.json()
    assert len(metas) == 1
    assert metas[0]["conversation_id"] == cid

    turns = await client.get(f"/api/history/{cid}/turns", headers=HDR)
    assert turns.status_code == 200
    assert len(turns.json()) == 1
