"""Request authentication for the internal HTTP API.

Two headers gate every non-public endpoint:

  * ``X-Shared-Secret`` — a fixed string baked into the frontend bundle. Constant-time
    compared with the value in settings (defence-in-depth: even inside the trust
    boundary, never use plain ``==`` for secret comparison).
  * ``X-User-Id``       — free-form internal identifier (name / 工号). Becomes the
    isolation key for sessions + rate limiting.

The ``X-User-Id`` validation rules are deliberately strict — the value is used as
part of the JSON storage key in :mod:`backend.store` (``"<user>|<notebook>"``),
so anything that breaks that encoding or sneaks in HTTP-header injection is rejected.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from .config import Settings, get_settings

_MAX_USER_ID_LEN = 64
_FORBIDDEN_USER_ID_CHARS = ("|", "\r", "\n", "\t", "\x00")


async def require_internal_user(
    x_user_id: Annotated[str, Header(alias="X-User-Id")],
    x_shared_secret: Annotated[str, Header(alias="X-Shared-Secret")],
    settings: Annotated[Settings, Depends(get_settings)],
) -> str:
    """Validate headers and return the canonical ``user_id`` for use downstream."""
    if not hmac.compare_digest(x_shared_secret, settings.internal_auth_shared_secret):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="无效凭证")

    uid = x_user_id.strip()
    if not uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="无效 X-User-Id (empty)")
    if len(uid) > _MAX_USER_ID_LEN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="无效 X-User-Id (>64 chars)")
    if any(c in uid for c in _FORBIDDEN_USER_ID_CHARS):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="无效 X-User-Id (forbidden chars)")
    return uid
