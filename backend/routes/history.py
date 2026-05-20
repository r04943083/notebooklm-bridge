"""GET /api/history, GET /api/history/{conversation_id}/turns, DELETE /api/history.

Writes happen inside ``POST /api/chat`` (see ``chat.py``: ``store.append_turn``) —
there is no public ``POST /history`` endpoint. The bridge owns the history, so the
same X-User-Id sees the same conversation log from any browser.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..auth import require_internal_user
from ..schemas import Citation, ConvMeta, TurnRecord

router = APIRouter()


@router.get("/history", response_model=list[ConvMeta])
async def list_history(
    notebook_id: str,
    request: Request,
    user_id: Annotated[str, Depends(require_internal_user)],
) -> list[ConvMeta]:
    """List conversations for (user, notebook), most-recent-activity first.

    No allowlist check on ``notebook_id``: that's a write-side concern. A user can
    always read their own history even if the notebook was later moved out of the
    allowlist.
    """
    if not notebook_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="notebook_id 必填")
    store = request.app.state.store
    metas = store.get_histories(user_id, notebook_id)
    # Store keeps "most-recent-activity at tail"; reverse for "newest first" wire order.
    return [
        ConvMeta(
            conversation_id=m.conversation_id,
            first_question=m.first_question,
            ts=m.ts,
        )
        for m in reversed(metas)
    ]


@router.get("/history/{conversation_id}/turns", response_model=list[TurnRecord])
async def get_conversation_turns(
    conversation_id: str,
    request: Request,
    user_id: Annotated[str, Depends(require_internal_user)],
) -> list[TurnRecord]:
    """Return all turns for a conversation owned by the requesting user.

    Access control: 404 (not 403) when the conversation is unknown OR belongs to
    another user. Conflating the two cases prevents using this endpoint to
    enumerate other users' conversation IDs.
    """
    if not conversation_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="conversation_id 必填")
    store = request.app.state.store
    if not store.has_turns(user_id, conversation_id):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="conversation 不存在或不属于当前用户"
        )
    turns = store.get_turns(user_id, conversation_id)
    return [
        TurnRecord(
            turn=t.turn,
            question=t.question,
            answer=t.answer,
            citations=[Citation(**c) for c in t.citations],
        )
        for t in turns
    ]


@router.delete("/history", status_code=status.HTTP_204_NO_CONTENT)
async def clear_history(
    notebook_id: str,
    request: Request,
    user_id: Annotated[str, Depends(require_internal_user)],
) -> Response:
    """Drop all conversations + their turns + the session cid pointer for
    (user, notebook). Idempotent — clearing an already-empty notebook is fine.
    """
    if not notebook_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="notebook_id 必填")
    request.app.state.store.clear_history(user_id, notebook_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
