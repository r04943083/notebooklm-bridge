"""Singleton in-memory store with JSON file persistence.

Holds three pieces of mutable state shared across all requests:
  1. ``sessions``   — per-(user, notebook) conversation_id, persisted across restarts
  2. ``rate_buckets`` — per-user token buckets, NOT persisted (refill in seconds; persisting
                        would let a bad actor accumulate tokens by restarting the service)
  3. ``circuit_open_until`` — global breaker cooldown deadline (monotonic), RESET to 0 on
                              load (a restart is an operator action; making the operator
                              wait for cooldown to expire is bad UX)

Writes to persistent fields trigger a debounced (1-second trailing) background flush.
On lifespan shutdown the app awaits one final flush so no in-flight write is lost.

Time is ``time.monotonic`` everywhere so wall-clock NTP jumps cannot accidentally trip
or extend the breaker / refill cycle.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

logger = logging.getLogger(__name__)

_STATE_VERSION = 1
_DEBOUNCE_SECONDS = 1.0


@dataclass
class _Bucket:
    tokens: float
    last_refill_ts: float


class Store:
    """Application-wide state container. Use ``Store.load(...)`` to construct."""

    _instance: ClassVar[Store | None] = None

    def __init__(self, state_path: Path) -> None:
        self._path: Path = state_path
        self._lock: asyncio.Lock = asyncio.Lock()
        self.sessions: dict[tuple[str, str], str] = {}
        self.rate_buckets: dict[str, _Bucket] = {}
        self.circuit_open_until: float = 0.0
        self._dirty: bool = False
        self._flush_task: asyncio.Task[None] | None = None

        # populated by load() from Settings
        self._cfg_rate_per_minute: int = 10
        self._cfg_burst: int = 3
        self._cfg_breaker_cooldown: int = 30

    # ------------------------------------------------------------------
    # Factory / lifecycle
    # ------------------------------------------------------------------
    @classmethod
    def load(cls, state_path: Path, cfg: object) -> Store:
        """Synchronous loader. Called once from FastAPI lifespan before the event loop
        accepts requests. Returns the singleton instance.

        ``cfg`` is a ``Settings`` instance but typed as ``object`` to avoid an import
        cycle; we only read the rate/burst/breaker fields.
        """
        store = cls(state_path)
        # Pull only the runtime knobs we need; never store cfg itself.
        store._cfg_rate_per_minute = int(getattr(cfg, "rate_limit_per_minute", 10))
        store._cfg_burst = int(getattr(cfg, "rate_limit_burst", 3))
        store._cfg_breaker_cooldown = int(getattr(cfg, "circuit_breaker_cooldown", 30))

        if state_path.exists():
            try:
                raw = state_path.read_text(encoding="utf-8")
                data = json.loads(raw) if raw else {}
            except (OSError, json.JSONDecodeError) as e:
                logger.exception("state.json unreadable at %s; starting fresh: %s", state_path, e)
                data = {}
            for key, value in data.get("sessions", {}).items():
                # tuple key "user|notebook" — split on the FIRST '|', user_id is validated
                # auth-side to disallow '|' so notebook_id can safely contain it.
                if "|" not in key:
                    continue
                user_id, notebook_id = key.split("|", 1)
                store.sessions[(user_id, notebook_id)] = value
            # circuit_open_until is intentionally NOT restored — see module docstring.
            # rate_buckets are intentionally NOT restored.

        cls._instance = store
        return store

    # ------------------------------------------------------------------
    # Session API
    # ------------------------------------------------------------------
    def get_session(self, user_id: str, notebook_id: str) -> str | None:
        return self.sessions.get((user_id, notebook_id))

    def set_session(self, user_id: str, notebook_id: str, conversation_id: str) -> None:
        self.sessions[(user_id, notebook_id)] = conversation_id
        self._schedule_flush()

    def reset_session(self, user_id: str, notebook_id: str) -> None:
        self.sessions.pop((user_id, notebook_id), None)
        self._schedule_flush()

    # ------------------------------------------------------------------
    # Rate limiter — leaky-bucket / token-bucket hybrid
    # ------------------------------------------------------------------
    def try_acquire_rate(self, user_id: str) -> bool:
        """Take one token for ``user_id``. Returns True if granted, False if exhausted.

        Capacity = ``rate_limit_burst``; refill rate = ``rate_limit_per_minute / 60`` t/s.
        """
        now = time.monotonic()
        bucket = self.rate_buckets.get(user_id)
        if bucket is None:
            bucket = _Bucket(tokens=float(self._cfg_burst), last_refill_ts=now)
            self.rate_buckets[user_id] = bucket
        else:
            elapsed = max(0.0, now - bucket.last_refill_ts)
            refill = elapsed * (self._cfg_rate_per_minute / 60.0)
            bucket.tokens = min(float(self._cfg_burst), bucket.tokens + refill)
            bucket.last_refill_ts = now

        if bucket.tokens >= 1.0:
            bucket.tokens -= 1.0
            return True
        return False

    # ------------------------------------------------------------------
    # Circuit breaker
    # ------------------------------------------------------------------
    def is_circuit_open(self) -> bool:
        return time.monotonic() < self.circuit_open_until

    def trip_circuit(self) -> None:
        self.circuit_open_until = time.monotonic() + self._cfg_breaker_cooldown
        # Not persisted — see module docstring. Skip _schedule_flush.

    # ------------------------------------------------------------------
    # Persistence (debounced)
    # ------------------------------------------------------------------
    def _schedule_flush(self) -> None:
        """Re-arm the debounce timer; the previous pending write is cancelled."""
        self._dirty = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop yet (e.g. constructed inside Store.load before lifespan
            # entered the loop). The state is still marked dirty; whoever shuts the
            # app down will call flush() unconditionally.
            return
        if self._flush_task is not None and not self._flush_task.done():
            self._flush_task.cancel()
        self._flush_task = loop.create_task(self._debounced_flush())

    async def _debounced_flush(self) -> None:
        try:
            await asyncio.sleep(_DEBOUNCE_SECONDS)
        except asyncio.CancelledError:
            return  # a newer write re-armed; let the latest task win
        async with self._lock:
            try:
                await self._do_flush()
                self._dirty = False
            except OSError:
                logger.exception("state.json flush failed; will retry on next mutation")

    async def flush(self) -> None:
        """Unconditional synchronous flush. Called at lifespan shutdown to ensure no
        debounce-pending mutation is lost.
        """
        if self._flush_task is not None and not self._flush_task.done():
            self._flush_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._flush_task
        async with self._lock:
            await self._do_flush()
            self._dirty = False

    async def _do_flush(self) -> None:
        payload = {
            "version": _STATE_VERSION,
            "sessions": {f"{u}|{n}": cid for (u, n), cid in self.sessions.items()},
            # circuit_open_until is omitted on purpose — restart resets the breaker
        }
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)
