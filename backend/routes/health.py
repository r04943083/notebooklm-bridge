"""GET /api/healthz — unauthenticated health endpoint.

Exposes only system status (no PII, no notebook contents). The runbooks and any
monitoring scripts hit this; restricting it behind ``X-Shared-Secret`` would make
ops harder for no real security gain (the trust boundary is enforced at the
network layer via nginx IP allowlist, per plan.md §风险与缓解).
"""

from __future__ import annotations

import importlib.metadata

from fastapi import APIRouter, Request

from ..schemas import HealthResponse

router = APIRouter()


@router.get("/healthz", response_model=HealthResponse)
async def healthz(request: Request) -> HealthResponse:
    s = request.app.state
    try:
        version = importlib.metadata.version("notebooklm-py")
    except importlib.metadata.PackageNotFoundError:
        version = "not-installed"

    return HealthResponse(
        auth_valid=bool(getattr(s, "auth_valid", False)),
        last_refresh_ts=getattr(s, "last_refresh_ts", None),
        last_rpc_ts=getattr(s, "last_rpc_ts", None),
        inflight_asks=int(getattr(s, "inflight", 0)),
        circuit_open=s.store.is_circuit_open() if hasattr(s, "store") else False,
        notebooklm_py_version=version,
    )
