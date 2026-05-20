"""Singleton in-memory store with JSON file persistence.

Holds five pieces of mutable state shared across all requests:
  1. ``sessions``   — per-(user, notebook) conversation_id, persisted across restarts
  2. ``histories``  — per-(user, notebook) list of ConvMeta (most-recent-activity at tail);
                       capped at ``_HISTORY_CAP_PER_NOTEBOOK`` per (user, notebook), persisted
  3. ``turns``      — per-(user, conversation) ordered list of TurnRecord, persisted
  4. ``rate_buckets`` — per-user token buckets, NOT persisted (refill in seconds; persisting
                        would let a bad actor accumulate tokens by restarting the service)
  5. ``circuit_open_until`` — global breaker cooldown deadline (monotonic), RESET to 0 on
                              load (a restart is an operator action; making the operator
                              wait for cooldown to expire is bad UX)

Writes to persistent fields trigger a debounced (1-second trailing) background flush.
On lifespan shutdown the app awaits one final flush so no in-flight write is lost.

Time is ``time.monotonic`` everywhere for breaker / rate-limit accounting so wall-clock
NTP jumps cannot accidentally trip or extend the breaker / refill cycle. The exception
is ConvMeta.ts, which is wall-clock epoch ms because it's only used for UI sort order
("most-recent first") and humans expect wall-clock semantics there.

state.json layout (version 2, see ``_STATE_VERSION``):

    {
      "version":   2,
      "sessions":  {"<uid>|<nbid>": "<cid>", ...},
      "histories": {"<uid>|<nbid>": [ConvMeta, ...], ...},
      "turns":     {"<uid>|<cid>":  [TurnRecord, ...], ...}
    }

Capacity: 20 conv/notebook × ~30 turn/conv × ~1KB/turn keeps state.json well under 1MB
in realistic workloads. The current full-rewrite flush (``tmp.write_text`` + ``os.replace``)
handles that range fine; if state.json grows past ~5MB in production, split histories/turns
out into a sharded file — but don't pre-optimise.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, ClassVar

logger = logging.getLogger(__name__)

_STATE_VERSION = 2
_DEBOUNCE_SECONDS = 1.0
_HISTORY_CAP_PER_NOTEBOOK = 20


@dataclass
class _Bucket:
    tokens: float
    last_refill_ts: float


@dataclass
class ConvMeta:
    conversation_id: str
    first_question: str
    ts: int  # wall-clock epoch ms; used only for UI sort order


@dataclass
class TurnRecord:
    turn: int
    question: str
    answer: str
    # citations are stored as raw list[dict] (already coerced by chat route via
    # Citation.model_dump()). Keeping them as dicts here avoids importing Pydantic
    # schemas into the store module — schemas.py imports from store would otherwise
    # form a cycle. The route layer lifts back into Pydantic via ``list[Citation]``.
    citations: list[dict[str, Any]] = field(default_factory=list)


class Store:
    """Application-wide state container. Use ``Store.load(...)`` to construct."""

    _instance: ClassVar[Store | None] = None

    def __init__(self, state_path: Path) -> None:
        self._path: Path = state_path
        self._lock: asyncio.Lock = asyncio.Lock()
        self.sessions: dict[tuple[str, str], str] = {}
        # histories[(uid, nbid)] is ordered by most-recent-activity: tail = most recent.
        # _cap_histories trims the head when len > _HISTORY_CAP_PER_NOTEBOOK, so the cap
        # drops the least-recently-active conversation (never the popular one being
        # actively continued — see append_turn's promote-on-hit behaviour).
        self.histories: dict[tuple[str, str], list[ConvMeta]] = {}
        self.turns: dict[tuple[str, str], list[TurnRecord]] = {}
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

            version = data.get("version")
            if version not in (None, 1, 2):
                logger.warning(
                    "state.json version=%r unknown; treating as fresh (sessions/histories empty)",
                    version,
                )
                data = {}

            for key, value in data.get("sessions", {}).items():
                # tuple key "user|notebook" — split on the FIRST '|', user_id is validated
                # auth-side to disallow '|' so notebook_id can safely contain it.
                if "|" not in key:
                    continue
                user_id, notebook_id = key.split("|", 1)
                store.sessions[(user_id, notebook_id)] = value

            # histories/turns only exist in v2+; v1 files (or fresh files with no version
            # key) leave these empty and the next flush automatically rewrites the file
            # at the current _STATE_VERSION.
            if version == 2:
                for key, entries in data.get("histories", {}).items():
                    if "|" not in key:
                        continue
                    user_id, notebook_id = key.split("|", 1)
                    store.histories[(user_id, notebook_id)] = [
                        ConvMeta(
                            conversation_id=str(e["conversation_id"]),
                            first_question=str(e["first_question"]),
                            ts=int(e["ts"]),
                        )
                        for e in entries
                    ]
                for key, entries in data.get("turns", {}).items():
                    if "|" not in key:
                        continue
                    user_id, conversation_id = key.split("|", 1)
                    store.turns[(user_id, conversation_id)] = [
                        TurnRecord(
                            turn=int(e["turn"]),
                            question=str(e["question"]),
                            answer=str(e["answer"]),
                            citations=list(e.get("citations", [])),
                        )
                        for e in entries
                    ]
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
    # History / turns API
    # ------------------------------------------------------------------
    def append_turn(
        self,
        user_id: str,
        notebook_id: str,
        conversation_id: str,
        question: str,
        answer: str,
        citations: list[dict[str, Any]],
        turn_number: int,
    ) -> None:
        """Persist one chat turn and update the conversation's position in the history.

        If the conversation already exists in the (user, notebook) history, its ConvMeta
        is promoted to the tail (= most recent) with a fresh ``ts``. If it's new, a new
        ConvMeta is appended and the list is capped to ``_HISTORY_CAP_PER_NOTEBOOK``.

        first_question is taken from the *first* time we see this conversation_id, so it
        always reflects turn 1's question even on later appends.
        """
        self.turns.setdefault((user_id, conversation_id), []).append(
            TurnRecord(
                turn=turn_number,
                question=question,
                answer=answer,
                citations=list(citations),
            )
        )

        now_ms = int(time.time() * 1000)
        bucket = self.histories.setdefault((user_id, notebook_id), [])
        hit_idx = next(
            (i for i, m in enumerate(bucket) if m.conversation_id == conversation_id),
            None,
        )
        if hit_idx is not None:
            meta = bucket.pop(hit_idx)
            meta.ts = now_ms
            bucket.append(meta)
        else:
            bucket.append(
                ConvMeta(
                    conversation_id=conversation_id,
                    first_question=question,
                    ts=now_ms,
                )
            )
            self._cap_histories(user_id, notebook_id)

        self._schedule_flush()

    def get_histories(self, user_id: str, notebook_id: str) -> list[ConvMeta]:
        """Return a shallow copy of the conversation list (tail = most recent)."""
        return list(self.histories.get((user_id, notebook_id), []))

    def get_turns(self, user_id: str, conversation_id: str) -> list[TurnRecord]:
        """Return a shallow copy of the turn list (ordered by turn number ascending)."""
        return list(self.turns.get((user_id, conversation_id), []))

    def has_turns(self, user_id: str, conversation_id: str) -> bool:
        """Existence check used by the route layer for access control.

        Returns True iff (user_id, conversation_id) is a known key. The route translates
        False into 404, deliberately conflating "doesn't exist" with "belongs to another
        user" so the endpoint can't be used to enumerate other users' conversation IDs.
        """
        return (user_id, conversation_id) in self.turns

    def clear_history(self, user_id: str, notebook_id: str) -> None:
        """Drop all history + turns + the session cid pointer for (user, notebook).

        Inlines the session pop instead of calling reset_session() so a single flush is
        scheduled (reset_session also schedules one).
        """
        entries = self.histories.pop((user_id, notebook_id), [])
        for entry in entries:
            self.turns.pop((user_id, entry.conversation_id), None)
        self.sessions.pop((user_id, notebook_id), None)
        self._schedule_flush()

    def _cap_histories(self, user_id: str, notebook_id: str) -> None:
        """Trim the (user, notebook) history list to at most _HISTORY_CAP_PER_NOTEBOOK.

        Drops from the HEAD because append_turn keeps the list ordered with most-recent-
        activity at the tail. The dropped conversations' turns are also evicted so they
        don't grow unboundedly. Does not schedule a flush — the caller (append_turn)
        does that exactly once.
        """
        bucket = self.histories.get((user_id, notebook_id))
        if bucket is None or len(bucket) <= _HISTORY_CAP_PER_NOTEBOOK:
            return
        overflow = len(bucket) - _HISTORY_CAP_PER_NOTEBOOK
        to_drop = bucket[:overflow]
        for entry in to_drop:
            self.turns.pop((user_id, entry.conversation_id), None)
        self.histories[(user_id, notebook_id)] = bucket[overflow:]

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
            "histories": {
                f"{u}|{n}": [asdict(m) for m in lst]
                for (u, n), lst in self.histories.items()
            },
            "turns": {
                f"{u}|{cid}": [asdict(t) for t in lst]
                for (u, cid), lst in self.turns.items()
            },
            # circuit_open_until is omitted on purpose — restart resets the breaker
        }
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)
