"""NotebookLMClient lifecycle: lazy import, keepalive task, and graceful shutdown.

notebooklm-py is loaded LAZILY (inside a function, not at module import) for two
reasons:

  1. The bridge is shipped with notebooklm-py as an OPTIONAL extra
     (``pip install -e '.[runtime]'``). Tests and dev installs don't need it; the
     module import path must succeed regardless.
  2. The upstream import side-effects (cookie/keychain access) should run only on
     a real startup, not during ``backend.app`` import (e.g. autoreload checks).

If notebooklm-py is missing or the cookies file is unreadable, the FastAPI
lifespan catches the exception and continues with ``app.state.client = None``.
Routes return 503 in that mode; ``/api/healthz`` reports ``auth_valid=false``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from .config import Settings

if TYPE_CHECKING:
    from ._notebooklm_protocol import NotebookLMClientLike

logger = logging.getLogger(__name__)


class NotebookLMNotInstalled(RuntimeError):
    """Raised when ``notebooklm-py`` cannot be imported; treated as recoverable
    by the lifespan (service starts in degraded mode)."""


def _import_notebooklm() -> tuple[Any, tuple[type[BaseException], ...]]:
    """Return ``(NotebookLMClient, upstream_exception_classes)`` or raise
    :class:`NotebookLMNotInstalled`.

    ``upstream_exception_classes`` is the tuple ``chat.py`` matches against to
    decide between "trip breaker / 503" and "let it bubble". Names are best-effort
    and adapted to the version pinned in Phase 1 — see
    ``docs/notebooklm-py-integration.md``.
    """
    try:
        from notebooklm import NotebookLMClient
    except ImportError as e:
        raise NotebookLMNotInstalled(
            "notebooklm-py is not installed. Complete Phase 1 first, then run "
            "`pip install -e '.[runtime]'`. See docs/notebooklm-py-integration.md."
        ) from e

    # Pull upstream exception classes if they exist; otherwise fall back to a
    # generic Exception tuple so chat.py never KeyErrors on a missing name.
    # Class names follow notebooklm-py 0.4.x; if upstream renames, update the
    # tuple here and the AuthError-string match in routes/chat.py.
    upstream_excs: list[type[BaseException]] = []
    try:
        from notebooklm.exceptions import (
            AuthError,
            RateLimitError,
            ServerError,
        )

        upstream_excs.extend([RateLimitError, ServerError, AuthError])
    except ImportError:
        logger.warning(
            "notebooklm.exceptions not available; using generic Exception for upstream errors"
        )

    return NotebookLMClient, tuple(upstream_excs)


async def build_client(cfg: Settings) -> NotebookLMClientLike:
    """Instantiate the upstream client from the auth.json on disk. May raise
    :class:`NotebookLMNotInstalled`, ``FileNotFoundError``, or any exception
    notebooklm-py emits when cookies are invalid; the lifespan handles all of them.
    """
    NotebookLMClient, _ = _import_notebooklm()
    # The constructor name across notebooklm-py releases has been `from_storage` —
    # adjust here in Phase 1 if upstream renames it. Keep the call site identical.
    client: NotebookLMClientLike = await NotebookLMClient.from_storage(cfg.auth_json_path)
    return client


async def keepalive_loop(
    client: NotebookLMClientLike,
    cfg: Settings,
    *,
    on_refresh: Callable[[float], None],
) -> None:
    """Background task that pings the upstream every ``notebooklm_keepalive_seconds``.

    Calls ``notebooks.list()`` as a lightweight read that also refreshes the
    ``__Secure-1PSIDTS`` cookie. Swallows all non-cancellation errors — a single
    transient failure should not kill the loop. The lifespan cancels this task on
    shutdown; :exc:`asyncio.CancelledError` is propagated.
    """
    interval = max(60, int(cfg.notebooklm_keepalive_seconds))
    while True:
        try:
            await asyncio.sleep(interval)
            await client.notebooks.list()
            on_refresh(time.time())
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("keepalive ping failed; cookies may be expiring")
