"""GET /api/sources/{source_id}/fulltext — fetch the indexed text content of a
single source.

This is a thin proxy in front of ``client.sources.get_fulltext(notebook_id,
source_id)``. The same three protections that chat.py enforces apply here,
because every call is still an upstream RPC against the shared Google account:

  1. client live   — 503 if upstream cookies aren't ready
  2. circuit open  — short-circuit while the breaker is tripped
  3. semaphore     — count against the global inflight cap
  4. wait_for      — bounded latency

Per-user rate limiting is intentionally *not* applied here: a fulltext fetch is
cheaper than a chat ask, and users will reasonably click it once per citation.
If empirical evidence shows that needs revisiting, add ``store.try_acquire_rate``
on the same pattern as ``chat.py``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..auth import require_internal_user
from ..config import Settings, get_settings
from ..schemas import SourceFulltext

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/sources/{source_id}/fulltext", response_model=SourceFulltext)
async def get_source_fulltext(
    source_id: str,
    notebook_id: str,
    request: Request,
    _user_id: Annotated[str, Depends(require_internal_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SourceFulltext:
    # 1. client live
    client = request.app.state.client
    if client is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="NotebookLM 登录凭证已失效或未配置。请通知系统管理员重新登录(管理员操作:在 bridge 主机执行 `bash scripts/login.sh` 后重启服务)。"
        )

    store = request.app.state.store

    # 2. circuit breaker
    if store.is_circuit_open():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="上游限流冷却中,请稍后重试"
        )

    upstream_excs: tuple[type[BaseException], ...] = getattr(
        request.app.state, "upstream_exceptions", ()
    )

    # 3 + 4. semaphore + bounded wait
    async with request.app.state.semaphore:
        request.app.state.inflight = int(getattr(request.app.state, "inflight", 0)) + 1
        try:
            try:
                result: Any = await asyncio.wait_for(
                    client.sources.get_fulltext(notebook_id, source_id),
                    timeout=settings.ask_timeout_seconds,
                )
            except TimeoutError as e:
                logger.warning(
                    "sources.get_fulltext timeout notebook=%s source=%s",
                    notebook_id,
                    source_id,
                )
                raise HTTPException(
                    status.HTTP_504_GATEWAY_TIMEOUT, detail="上游超时,请重试"
                ) from e
            except upstream_excs as e:
                name = type(e).__name__
                logger.warning("upstream error %s on get_fulltext; tripping circuit", name)
                store.trip_circuit()
                if name in ("AuthError", "AuthExpired"):
                    request.app.state.auth_valid = False
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE, detail="上游异常,服务暂歇"
                ) from e

            request.app.state.last_rpc_ts = time.time()
        finally:
            request.app.state.inflight = max(
                0, int(getattr(request.app.state, "inflight", 1)) - 1
            )

    kind_raw = getattr(result, "kind", None)
    return SourceFulltext(
        source_id=str(getattr(result, "source_id", source_id)),
        title=getattr(result, "title", None),
        kind=str(kind_raw) if kind_raw is not None else None,
        url=getattr(result, "url", None),
        content=str(getattr(result, "content", "") or ""),
        char_count=int(
            getattr(result, "char_count", None) or len(getattr(result, "content", "") or "")
        ),
    )
