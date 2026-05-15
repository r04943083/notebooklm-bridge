"""Centralised logging setup. Called once from the FastAPI lifespan, as early
as possible so any code that imports ``logging.getLogger`` afterwards picks up
the configured handler.
"""

from __future__ import annotations

import logging
import sys


def setup_logging(level: str = "INFO") -> None:
    """Configure the root logger with an ISO-timestamp formatter writing to stderr.

    Idempotent: safe to call multiple times (e.g. from tests). We strip pre-existing
    handlers so repeated calls don't duplicate every log line.
    """
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)s [%(name)s] %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root.addHandler(handler)
    root.setLevel(level.upper())
