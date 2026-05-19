"""Request authentication for the internal HTTP API.

A single header gates every non-public endpoint:

  * ``X-User-Id`` — free-form internal identifier (name / 工号). Becomes the
    isolation key for sessions + rate limiting.

The ``X-User-Id`` validation rules are deliberately strict — the value is used as
part of the JSON storage key in :mod:`backend.store` (``"<user>|<notebook>"``),
so anything that breaks that encoding or sneaks in HTTP-header injection is rejected.

Up to v1.0.2 we also required an ``X-Shared-Secret`` header constant-time-
compared against a value in ``.env``. That broke v1.0.2's offline-deploy
flow: the secret has to live inside the frontend bundle, which is
pre-built on the developer's host with the developer's secret — and never
matches the secret the deploy host's ``deploy.sh`` auto-generates. The
LAN is already a trust boundary; the shared-secret check was security
theatre that introduced a real cross-host coupling bug, so it was
removed in v1.0.3.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Header, HTTPException, status

_MAX_USER_ID_LEN = 64
_FORBIDDEN_USER_ID_CHARS = ("|", "\r", "\n", "\t", "\x00")


async def require_internal_user(
    x_user_id: Annotated[str, Header(alias="X-User-Id")],
) -> str:
    """Validate the X-User-Id header and return the canonical ``user_id``."""
    uid = x_user_id.strip()
    if not uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="无效 X-User-Id (empty)")
    if len(uid) > _MAX_USER_ID_LEN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="无效 X-User-Id (>64 chars)")
    if any(c in uid for c in _FORBIDDEN_USER_ID_CHARS):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="无效 X-User-Id (forbidden chars)")
    return uid
