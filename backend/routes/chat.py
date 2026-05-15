"""POST /api/chat and POST /api/chat/reset.

The chat route is the single chokepoint that enforces every safety contract in
the system. The order of checks below is load-bearing:

  1. allowlist     — bail before any expensive work if notebook_id is rejected
  2. client live   — degrade to 503 if upstream cookies aren't ready
  3. circuit open  — global breaker after upstream 429/5xx
  4. per-user rate — token bucket; preserves fairness across users
  5. acquire semaphore — global inflight cap
  6. wait_for ask  — bounded per-request latency
  7. map exceptions — upstream errors trip breaker; timeout does NOT

A single user's slow query must never trip the breaker — that would let one bad
question wedge everyone else. ``asyncio.TimeoutError`` therefore becomes 504, not
503, and never calls ``store.trip_circuit()``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..auth import require_internal_user
from ..config import Settings, get_settings
from ..schemas import ChatRequest, ChatResponse, Citation

logger = logging.getLogger(__name__)
router = APIRouter()


def _coerce_citations(raw: Any) -> list[Citation]:
    """Tolerantly turn whatever the upstream returned into our Citation model.

    notebooklm-py 0.4.x returns ``ChatReference`` objects with fields
    ``source_id / citation_number / cited_text / start_char / end_char``. We
    map those onto our older Citation schema so the frontend doesn't need to
    care which upstream version the bridge is running against. Older releases
    that used ``citations / source_title / text / page`` still work because we
    look up either name via ``getattr``.
    """
    out: list[Citation] = []
    if not raw:
        return out
    for c in raw:
        if isinstance(c, dict):
            out.append(
                Citation(
                    source_id=str(c.get("source_id", "")),
                    source_title=str(c.get("source_title", "")),
                    text=str(c.get("cited_text") or c.get("text") or ""),
                    page=c.get("citation_number") or c.get("page"),
                )
            )
        else:
            out.append(
                Citation(
                    source_id=str(getattr(c, "source_id", "")),
                    # source_title is not present on notebooklm-py 0.4.x
                    # ChatReference; the frontend's citation list shows the
                    # source_id in that case until a future enrichment hop
                    # joins it against /api/sources.
                    source_title=str(getattr(c, "source_title", "")),
                    text=str(
                        getattr(c, "cited_text", None) or getattr(c, "text", "") or ""
                    ),
                    page=getattr(c, "citation_number", None) or getattr(c, "page", None),
                )
            )
    return out


@router.post("/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    request: Request,
    user_id: Annotated[str, Depends(require_internal_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> ChatResponse:
    # 1. allowlist
    if settings.allowed_notebook_ids and req.notebook_id not in settings.allowed_notebook_ids:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="notebook 不在允许列表")

    # 2. client live
    client = request.app.state.client
    if client is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="服务暂不可用 — 上游凭证未就绪"
        )

    store = request.app.state.store

    # 3. circuit breaker
    if store.is_circuit_open():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="上游限流冷却中,请稍后重试")

    # 4. per-user rate
    if not store.try_acquire_rate(user_id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="请求过频,请稍候",
            headers={"Retry-After": "6"},
        )

    cid: str | None = None if req.reset else store.get_session(user_id, req.notebook_id)

    upstream_excs: tuple[type[BaseException], ...] = getattr(
        request.app.state, "upstream_exceptions", ()
    )

    # 5 + 6. semaphore + bounded wait
    async with request.app.state.semaphore:
        request.app.state.inflight = int(getattr(request.app.state, "inflight", 0)) + 1
        try:
            try:
                result = await asyncio.wait_for(
                    client.chat.ask(
                        notebook_id=req.notebook_id,
                        question=req.question,
                        source_ids=req.source_ids,
                        conversation_id=cid,
                    ),
                    timeout=settings.ask_timeout_seconds,
                )
            except TimeoutError as e:
                # 7a. timeout: 504, do NOT trip breaker
                logger.warning("chat.ask timeout user=%s notebook=%s", user_id, req.notebook_id)
                raise HTTPException(
                    status.HTTP_504_GATEWAY_TIMEOUT, detail="上游超时,请重试"
                ) from e
            except upstream_excs as e:
                # 7b. upstream rate-limit / 5xx / auth-expired → trip breaker
                name = type(e).__name__
                logger.warning("upstream error %s; tripping circuit", name)
                store.trip_circuit()
                # notebooklm-py 0.4.x renamed AuthExpired → AuthError; accept both
                # so this code keeps working across upstream renames.
                if name in ("AuthError", "AuthExpired"):
                    request.app.state.auth_valid = False
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE, detail="上游异常,服务暂歇"
                ) from e

            request.app.state.last_rpc_ts = time.time()
        finally:
            request.app.state.inflight = max(0, int(getattr(request.app.state, "inflight", 1)) - 1)

    new_cid = str(getattr(result, "conversation_id", "") or cid or "")
    if new_cid:
        store.set_session(user_id, req.notebook_id, new_cid)

    # notebooklm-py 0.4.x: AskResult.references (was .citations) +
    # AskResult.turn_number (was .turn). Read both names for forward / backward
    # compatibility.
    references = getattr(result, "references", None)
    if references is None:
        references = getattr(result, "citations", None)
    return ChatResponse(
        answer=str(getattr(result, "answer", "")),
        citations=_coerce_citations(references),
        conversation_id=new_cid,
        turn=int(getattr(result, "turn_number", None) or getattr(result, "turn", 1) or 1),
    )


@router.post("/chat/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_chat(
    notebook_id: str,
    request: Request,
    user_id: Annotated[str, Depends(require_internal_user)],
) -> Response:
    request.app.state.store.reset_session(user_id, notebook_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
