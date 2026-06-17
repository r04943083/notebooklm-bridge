"""Header-based auth dependency tests. Exercises every reject branch in
``backend.auth.require_internal_user``.

The X-Shared-Secret header check was removed in v1.0.3 — see backend/auth.py
for the rationale. The only remaining authn surface is X-User-Id validation.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient


async def test_valid_request_passes(client: AsyncClient) -> None:
    resp = await client.get("/api/notebooks", headers={"X-User-Id": "alice"})
    assert resp.status_code == 200


async def test_missing_user_id_returns_422(client: AsyncClient) -> None:
    resp = await client.get("/api/notebooks", headers={})
    assert resp.status_code in (401, 422)  # FastAPI returns 422 for missing Header


async def test_extra_shared_secret_header_is_ignored(client: AsyncClient) -> None:
    """Legacy clients (browsers loading a pre-v1.0.3 bundle) may still send
    X-Shared-Secret. The backend must ignore it, not reject the request."""
    resp = await client.get(
        "/api/notebooks",
        headers={"X-User-Id": "alice", "X-Shared-Secret": "anything-here"},
    )
    assert resp.status_code == 200


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


async def test_percent_encoded_chinese_user_id_passes(client: AsyncClient) -> None:
    """A non-Latin-1 name is percent-encoded by the frontend (HTTP header values
    must be ISO-8859-1). The backend urldecodes it before validating."""
    resp = await client.get(
        "/api/notebooks",
        headers={"X-User-Id": "%E4%B8%AD%E6%96%87"},  # encodeURIComponent("中文")
    )
    assert resp.status_code == 200


async def test_healthz_does_not_require_auth(client: AsyncClient) -> None:
    """Health endpoint is unauthenticated by design (runbooks need it)."""
    transport = client._transport  # type: ignore[attr-defined]
    async with AsyncClient(transport=transport, base_url="http://test") as anon:  # type: ignore[arg-type]
        resp = await anon.get("/api/healthz")
        assert resp.status_code == 200
        body: dict[str, Any] = resp.json()
        assert "auth_valid" in body
