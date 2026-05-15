"""Header-based auth dependency tests. Exercises every reject branch in
``backend.auth.require_internal_user``.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient


async def test_valid_request_passes(client: AsyncClient) -> None:
    resp = await client.get("/api/notebooks", headers={"X-User-Id": "alice"})
    assert resp.status_code == 200


async def test_missing_user_id_returns_422(client: AsyncClient) -> None:
    # Drop the X-Shared-Secret too so we don't half-authenticate
    resp = await client.get("/api/notebooks", headers={})
    assert resp.status_code in (401, 422)  # FastAPI returns 422 for missing Header


async def test_missing_shared_secret_returns_422(client: AsyncClient) -> None:
    # The shared secret is set in the fixture; override with empty
    resp = await client.get(
        "/api/notebooks",
        headers={"X-User-Id": "alice", "X-Shared-Secret": ""},
    )
    # Either constant-time comparison rejects (401), or missing → 422
    assert resp.status_code in (401, 422)


async def test_wrong_shared_secret_returns_401(client: AsyncClient) -> None:
    resp = await client.get(
        "/api/notebooks",
        headers={"X-User-Id": "alice", "X-Shared-Secret": "wrong-secret"},
    )
    assert resp.status_code == 401


@pytest.mark.parametrize(
    "user_id",
    [
        "x" * 65,  # too long
        "user|with|pipe",  # forbidden char
        "user\nwith\nnewline",  # control char
        "  ",  # only whitespace → strips to empty
    ],
)
async def test_invalid_user_id_returns_400(client: AsyncClient, user_id: str) -> None:
    resp = await client.get("/api/notebooks", headers={"X-User-Id": user_id})
    # 400 from our validator, but the FastAPI auto-422 may also catch some pre-validation
    assert resp.status_code in (400, 422), resp.text


async def test_healthz_does_not_require_auth(client: AsyncClient) -> None:
    """Health endpoint is unauthenticated by design (runbooks need it)."""
    # Use a fresh client without the shared secret to confirm.
    transport = client._transport  # type: ignore[attr-defined]
    async with AsyncClient(transport=transport, base_url="http://test") as anon:  # type: ignore[arg-type]
        resp = await anon.get("/api/healthz")
        assert resp.status_code == 200
        body: dict[str, Any] = resp.json()
        assert "auth_valid" in body
