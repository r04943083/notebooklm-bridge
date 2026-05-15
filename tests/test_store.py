"""Tests for backend.store.Store — the only file in this project without a
template, so everything load-bearing here is exercised explicitly.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from backend.store import Store

CFG = SimpleNamespace(rate_limit_per_minute=10, rate_limit_burst=3, circuit_breaker_cooldown=30)


def _new_store(state_path: Path) -> Store:
    return Store.load(state_path, CFG)


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------
async def test_session_get_set_reset(state_path: Path) -> None:
    s = _new_store(state_path)
    assert s.get_session("u1", "n1") is None
    s.set_session("u1", "n1", "cid-A")
    assert s.get_session("u1", "n1") == "cid-A"
    s.reset_session("u1", "n1")
    assert s.get_session("u1", "n1") is None


async def test_session_isolation_across_users(state_path: Path) -> None:
    s = _new_store(state_path)
    s.set_session("alice", "n1", "cid-alice")
    s.set_session("bob", "n1", "cid-bob")
    assert s.get_session("alice", "n1") == "cid-alice"
    assert s.get_session("bob", "n1") == "cid-bob"


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------
async def test_rate_limit_burst_then_block(state_path: Path) -> None:
    s = _new_store(state_path)
    # Burst = 3, so the first 3 succeed; the 4th within the same instant fails.
    assert s.try_acquire_rate("u") is True
    assert s.try_acquire_rate("u") is True
    assert s.try_acquire_rate("u") is True
    assert s.try_acquire_rate("u") is False


async def test_rate_limit_refill_over_time(state_path: Path) -> None:
    s = _new_store(state_path)
    # Drain the bucket
    for _ in range(3):
        assert s.try_acquire_rate("u") is True
    assert s.try_acquire_rate("u") is False

    # Fast-forward monotonic clock by 6.1s → ~1.017 tokens regenerated
    bucket = s.rate_buckets["u"]
    bucket.last_refill_ts -= 6.1
    assert s.try_acquire_rate("u") is True
    # And the next one should fail again (only ~0.017 tokens remaining)
    assert s.try_acquire_rate("u") is False


async def test_rate_limit_independent_users(state_path: Path) -> None:
    s = _new_store(state_path)
    for _ in range(3):
        s.try_acquire_rate("alice")
    assert s.try_acquire_rate("alice") is False
    # bob is untouched
    assert s.try_acquire_rate("bob") is True


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------
async def test_circuit_breaker_trip_and_recover(state_path: Path) -> None:
    cfg = SimpleNamespace(rate_limit_per_minute=10, rate_limit_burst=3, circuit_breaker_cooldown=1)
    s = Store.load(state_path, cfg)
    assert s.is_circuit_open() is False
    s.trip_circuit()
    assert s.is_circuit_open() is True
    await asyncio.sleep(1.05)
    assert s.is_circuit_open() is False


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------
async def test_persistence_roundtrip(state_path: Path) -> None:
    s1 = _new_store(state_path)
    s1.set_session("alice", "nb-1", "cid-A")
    s1.set_session("bob", "nb-2", "cid-B")
    s1.trip_circuit()
    await s1.flush()

    s2 = _new_store(state_path)
    assert s2.get_session("alice", "nb-1") == "cid-A"
    assert s2.get_session("bob", "nb-2") == "cid-B"
    # Circuit is intentionally NOT restored across restarts (see store.py module docstring).
    assert s2.is_circuit_open() is False


async def test_persistence_handles_notebook_id_with_pipe(state_path: Path) -> None:
    """user_id is auth-validated to ban '|', but notebook_id is not — make sure
    a notebook id containing '|' round-trips correctly."""
    s1 = _new_store(state_path)
    s1.set_session("user1", "nb|with|pipes", "cid-X")
    await s1.flush()

    s2 = _new_store(state_path)
    assert s2.get_session("user1", "nb|with|pipes") == "cid-X"


async def test_debounce_coalesces_writes(state_path: Path) -> None:
    """10 rapid writes should produce exactly 1 file write, not 10."""
    s = _new_store(state_path)
    write_count = 0

    real_do_flush = s._do_flush

    async def counting_flush() -> None:
        nonlocal write_count
        write_count += 1
        await real_do_flush()

    s._do_flush = counting_flush  # type: ignore[method-assign]

    for i in range(10):
        s.set_session(f"u{i}", "nb", f"cid-{i}")
    # All 10 calls happen synchronously inside the same loop tick; debounce should
    # collapse them. Wait for the 1s debounce to fire.
    await asyncio.sleep(1.3)
    assert write_count == 1


async def test_flush_failure_leaves_original_file_intact(state_path: Path) -> None:
    s = _new_store(state_path)
    s.set_session("u", "n", "cid-initial")
    await s.flush()
    original = state_path.read_text()

    # Mutate then arrange for os.replace to fail
    s.set_session("u", "n", "cid-corrupted")
    with patch("backend.store.os.replace", side_effect=OSError("simulated")):
        with pytest.raises(OSError):
            await s.flush()

    # The original file is untouched; the tmp file may or may not exist.
    assert state_path.read_text() == original


async def test_load_handles_missing_file(state_path: Path) -> None:
    assert not state_path.exists()
    s = _new_store(state_path)
    assert s.sessions == {}


async def test_load_handles_corrupt_json(state_path: Path) -> None:
    state_path.write_text("{not valid json")
    s = _new_store(state_path)
    assert s.sessions == {}


async def test_atomic_write_uses_replace(state_path: Path) -> None:
    s = _new_store(state_path)
    s.set_session("u", "n", "cid")
    await s.flush()
    # No leftover tmp file
    tmp = state_path.with_suffix(state_path.suffix + ".tmp")
    assert not tmp.exists()
    assert state_path.exists()
    assert os.path.getsize(state_path) > 0
