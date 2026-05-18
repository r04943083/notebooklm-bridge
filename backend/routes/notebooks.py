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

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_internal_user
from ..schemas import Notebook, Source

_T = TypeVar("_T")

router = APIRouter()

_CACHE_TTL_SECONDS = 30.0

# notebooklm-py 0.4.x Source.status is an int from SourceStatus
# (1=PROCESSING, 2=READY, 3=ERROR). Mirror that into a short string the
# frontend can switch on without importing the upstream enum.
_STATUS_CODE_TO_STR: dict[int, str] = {1: "processing", 2: "ready", 3: "error"}


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
        out: list[Notebook] = []
        for it in items:
            created: Any = getattr(it, "created_at", None)
            # notebooklm-py 0.4.x emits a datetime; serialise to ISO so the
            # JSON response is deterministic and the frontend can sort.
            if created is None:
                created_str: str | None = None
            elif hasattr(created, "isoformat"):
                created_str = created.isoformat()
            else:
                created_str = str(created)
            out.append(
                Notebook(
                    id=getattr(it, "id", ""),
                    title=getattr(it, "title", ""),
                    created_at=created_str,
                    sources_count=getattr(it, "sources_count", None),
                )
            )
        return out

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
        out: list[Source] = []
        for it in items:
            kind_raw = getattr(it, "kind", None)
            kind_str: str | None = str(kind_raw) if kind_raw is not None else None
            created: Any = getattr(it, "created_at", None)
            if created is None:
                created_str: str | None = None
            elif hasattr(created, "isoformat"):
                created_str = created.isoformat()
            else:
                created_str = str(created)
            status_str = _STATUS_CODE_TO_STR.get(int(getattr(it, "status", 0) or 0))
            out.append(
                Source(
                    id=getattr(it, "id", ""),
                    title=getattr(it, "title", "") or "",
                    kind=kind_str,
                    url=getattr(it, "url", None),
                    created_at=created_str,
                    status=status_str,
                )
            )
        return out

    return await _cache.get_or_set(f"sources:{notebook_id}", _load)
