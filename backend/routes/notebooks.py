"""GET /api/notebooks and GET /api/sources — read-only catalogue endpoints with
a 30-second TTL cache.

Why a custom TTL cache and not ``functools.lru_cache``: ``lru_cache`` does not
understand coroutines (it would cache the coroutine object, not its awaited
result) and has no expiry.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, TypeVar

_T = TypeVar("_T")

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_internal_user
from ..schemas import Notebook, Source

router = APIRouter()

_CACHE_TTL_SECONDS = 30.0


class _TTLCache:
    """Thin async-friendly TTL cache. One lock per key to avoid stampedes."""

    def __init__(self, ttl: float) -> None:
        self.ttl = ttl
        self._data: dict[str, tuple[float, Any]] = {}
        self._lock = asyncio.Lock()

    async def get_or_set(self, key: str, loader: Callable[[], Awaitable[_T]]) -> _T:
        async with self._lock:
            now = time.monotonic()
            cached = self._data.get(key)
            if cached is not None and now - cached[0] < self.ttl:
                return cached[1]  # type: ignore[no-any-return]
            value = await loader()
            self._data[key] = (now, value)
            return value


_cache = _TTLCache(ttl=_CACHE_TTL_SECONDS)


def _require_client(request: Request) -> Any:
    client = request.app.state.client
    if client is None:
        raise HTTPException(status_code=503, detail="服务暂不可用 — 上游凭证未就绪")
    return client


@router.get("/notebooks", response_model=list[Notebook])
async def list_notebooks(
    request: Request,
    _user_id: Annotated[str, Depends(require_internal_user)],
) -> list[Notebook]:
    client = _require_client(request)

    async def _load() -> list[Notebook]:
        items = await client.notebooks.list()
        return [
            Notebook(
                id=getattr(it, "id", ""),
                title=getattr(it, "title", ""),
                updated_at=getattr(it, "updated_at", None),
            )
            for it in items
        ]

    return await _cache.get_or_set("notebooks:all", _load)


@router.get("/sources", response_model=list[Source])
async def list_sources(
    notebook_id: str,
    request: Request,
    _user_id: Annotated[str, Depends(require_internal_user)],
) -> list[Source]:
    client = _require_client(request)

    async def _load() -> list[Source]:
        items = await client.sources.list(notebook_id)
        return [
            Source(
                id=getattr(it, "id", ""),
                title=getattr(it, "title", ""),
                kind=getattr(it, "kind", None),
            )
            for it in items
        ]

    return await _cache.get_or_set(f"sources:{notebook_id}", _load)
