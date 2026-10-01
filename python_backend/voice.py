"""LiveKit room-scoped access token service (stdlib-only HS256 JWT)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from urllib.parse import urlsplit

DEFAULT_TTL_SECONDS = 6 * 60 * 60
MIN_TTL_SECONDS = 60
MAX_TTL_SECONDS = 24 * 60 * 60
CLOCK_SKEW_SECONDS = 5
ROOM_PREFIX = "citadels-"
MAX_NAME_LENGTH = 24


def clamp_ttl(value: object) -> int:
    try:
        ttl = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_TTL_SECONDS
    if ttl <= 0:
        return DEFAULT_TTL_SECONDS
    return max(MIN_TTL_SECONDS, min(MAX_TTL_SECONDS, ttl))


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _normalize_url(raw: object) -> str:
    value = str(raw or "").strip()
    if not re.match(r"^(wss?|https?)://", value, re.IGNORECASE):
        return ""
    try:
        parsed = urlsplit(value)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            return ""
        return value.rstrip("/")
    except ValueError:
        return ""


def _clean_name(value: object) -> str:
    name = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    return name[:MAX_NAME_LENGTH] or "玩家"


class VoiceService:
    def __init__(self, env: dict[str, str] | None = None):
        env = os.environ if env is None else env
        self.url = _normalize_url(env.get("LIVEKIT_URL"))
        self.api_key = str(env.get("LIVEKIT_API_KEY") or "").strip()
        self.api_secret = str(env.get("LIVEKIT_API_SECRET") or "").strip()
        self.ttl_seconds = clamp_ttl(env.get("LIVEKIT_TOKEN_TTL"))
        self.missing = [name for name, value in (("LIVEKIT_URL", self.url),
                                                  ("LIVEKIT_API_KEY", self.api_key),
                                                  ("LIVEKIT_API_SECRET", self.api_secret)) if not value]
        self.configured = not self.missing

    def status(self) -> dict:
        return {"configured": self.configured,
                "url": self.url if self.configured else "",
                "ttlSeconds": self.ttl_seconds,
                "message": ("联机语音已就绪（LiveKit）" if self.configured else
                            "服务器未配置联机语音，需要设置 " + " / ".join(self.missing))}

    def token_for(self, room_id: object, identity: object, name: object,
                  now: int | None = None) -> dict:
        if not self.configured:
            raise ValueError(self.status()["message"])
        room_id = str(room_id or "").strip().upper()
        identity = str(identity or "").strip()
        if not re.fullmatch(r"[A-Z0-9]{4}", room_id):
            raise ValueError("房间号无效")
        if not identity:
            raise ValueError("缺少玩家标识")
        current = int(time.time()) if now is None else int(now)
        exp = current + self.ttl_seconds
        room = ROOM_PREFIX + room_id
        header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"},
                                    separators=(",", ":")).encode("utf-8"))
        payload = {"iss": self.api_key, "sub": identity,
                   "nbf": current - CLOCK_SKEW_SECONDS, "exp": exp,
                   "name": _clean_name(name),
                   "video": {"roomJoin": True, "room": room,
                             "canPublish": True, "canSubscribe": True}}
        encoded_payload = _b64url(json.dumps(payload, ensure_ascii=False,
                                             separators=(",", ":")).encode("utf-8"))
        signing_input = (header + "." + encoded_payload).encode("ascii")
        signature = hmac.new(self.api_secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
        return {"token": header + "." + encoded_payload + "." + _b64url(signature),
                "url": self.url, "room": room, "identity": identity, "expiresAt": exp * 1000}
