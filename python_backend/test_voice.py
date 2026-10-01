"""LiveKit JWT contract tests, verified with an independent HMAC path."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.voice import (DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS,
                                  MIN_TTL_SECONDS, VoiceService, clamp_ttl)


def _decode_segment(segment: str) -> dict:
    padded = segment + "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


class VoiceTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = {"LIVEKIT_URL": "wss://voice.example.test///",
                    "LIVEKIT_API_KEY": "api-key", "LIVEKIT_API_SECRET": "top-secret",
                    "LIVEKIT_TOKEN_TTL": "600"}
        self.voice = VoiceService(self.env)

    def test_status_normalization_and_ttl_clamps(self) -> None:
        self.assertEqual(self.voice.status()["url"], "wss://voice.example.test")
        self.assertEqual(clamp_ttl("bad"), DEFAULT_TTL_SECONDS)
        self.assertEqual(clamp_ttl(0), DEFAULT_TTL_SECONDS)
        self.assertEqual(clamp_ttl(1), MIN_TTL_SECONDS)
        self.assertEqual(clamp_ttl(999999), MAX_TTL_SECONDS)
        missing = VoiceService({"LIVEKIT_URL": "https://voice.example.test"}).status()
        self.assertFalse(missing["configured"])
        self.assertIn("LIVEKIT_API_KEY", missing["message"])

    def test_jwt_signature_claims_and_name_sanitization(self) -> None:
        now = 1_800_000_000
        result = self.voice.token_for("ab12", "player-1", "玩家\nA" * 20, now=now)
        header, payload, signature = result["token"].split(".")
        signing_input = (header + "." + payload).encode("ascii")
        expected = hmac.new(b"top-secret", signing_input, hashlib.sha256).digest()
        self.assertEqual(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)), expected)
        self.assertEqual(_decode_segment(header), {"alg": "HS256", "typ": "JWT"})
        claims = _decode_segment(payload)
        self.assertEqual(claims["iss"], "api-key")
        self.assertEqual(claims["sub"], "player-1")
        self.assertEqual(claims["nbf"], now - 5)
        self.assertEqual(claims["exp"], now + 600)
        self.assertEqual(claims["video"], {"roomJoin": True, "room": "citadels-AB12",
                                            "canPublish": True, "canSubscribe": True})
        self.assertEqual(result["expiresAt"], (now + 600) * 1000)
        self.assertNotIn("top-secret", result["token"])

    def test_invalid_url_or_room_is_rejected(self) -> None:
        self.assertFalse(VoiceService({"LIVEKIT_URL": "voice.example.test",
                                       "LIVEKIT_API_KEY": "k",
                                       "LIVEKIT_API_SECRET": "s"}).configured)
        with self.assertRaisesRegex(ValueError, "房间号无效"):
            self.voice.token_for("../../", "id", "name")


if __name__ == "__main__":
    unittest.main()
