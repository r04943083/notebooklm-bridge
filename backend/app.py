"""FastAPI application entry point.

The lifespan is intentionally fault-tolerant: if notebooklm-py is missing, the
cookies file is unreadable, or the upstream client cannot be built, the service
still starts. In that case ``app.state.client`` is ``None``; ``/api/healthz``
reports the cause via ``auth_valid=False`` and the chat / catalogue routes return
503. This is required by the Phase 2 DoD "凭证失效降级 → 503 不 500".
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .client import (
    NotebookLMNotInstalled,
    _import_notebooklm,
    build_client,
    keepalive_loop,
)
from .config import get_settings
from .logging_conf import setup_logging
from .routes import chat as chat_route
from .routes import health as health_route
from .routes import notebooks as notebooks_route
from .store import Store

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    cfg = get_settings()
    setup_logging(cfg.log_level)
    logger.info("lifespan start: backend on %s:%s", cfg.backend_host, cfg.backend_port)

    # State container is always present, even if the upstream client isn't.
    app.state.cfg = cfg
    app.state.store = Store.load(cfg.state_json, cfg)
    app.state.semaphore = asyncio.Semaphore(cfg.max_inflight_asks)
    app.state.inflight = 0
    app.state.last_refresh_ts = None
    app.state.last_rpc_ts = None
    app.state.auth_valid = False
    app.state.client = None
    app.state.upstream_exceptions = ()
    app.state.keepalive_task = None

    # Best-effort upstream client construction. Any failure leaves the app running
    # in degraded mode and is reported via /api/healthz.
    try:
        _, upstream_excs = _import_notebooklm()
        app.state.upstream_exceptions = upstream_excs
        app.state.client = await build_client(cfg)
        app.state.auth_valid = True
        app.state.last_refresh_ts = time.time()
        logger.info("notebooklm client ready")
    except NotebookLMNotInstalled as e:
        logger.critical("notebooklm-py missing — running in degraded mode: %s", e)
    except FileNotFoundError as e:
        logger.critical("auth.json not found at %s — running degraded: %s", cfg.auth_json_path, e)
    except Exception:
        logger.exception("client init failed — running in degraded mode")

    if app.state.client is not None:
        def _on_refresh(ts: float) -> None:
            app.state.last_refresh_ts = ts

        app.state.keepalive_task = asyncio.create_task(
            keepalive_loop(app.state.client, cfg, on_refresh=_on_refresh)
        )

    try:
        yield
    finally:
        if app.state.keepalive_task is not None:
            app.state.keepalive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await app.state.keepalive_task
        with contextlib.suppress(Exception):
            await app.state.store.flush()
        if app.state.client is not None:
            with contextlib.suppress(Exception):
                await app.state.client.close()
        logger.info("lifespan shutdown complete")


def create_app() -> FastAPI:
    cfg = get_settings()
    application = FastAPI(
        title="notebooklm-bridge",
        version="0.1.0",
        lifespan=lifespan,
    )

    # Single explicit origin — never "*". See plan.md §风险与缓解 + CLAUDE.md §3.6.
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[cfg.internal_frontend_origin],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-User-Id", "X-Shared-Secret"],
    )

    application.include_router(health_route.router, prefix="/api")
    application.include_router(notebooks_route.router, prefix="/api")
    application.include_router(chat_route.router, prefix="/api")
    return application


app = create_app()
