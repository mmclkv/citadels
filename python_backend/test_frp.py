"""Configuration and lifecycle tests for the opt-in FRP transport."""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend.frp import FrpManager, build_config


class FrpTests(unittest.TestCase):
    def test_http_config_and_tls_defaults_match_server_contract(self):
        config = build_config(8787, {"CITADELS_FRP_SERVER_ADDR": "frp.example",
            "CITADELS_FRP_TOKEN": "token\"quoted", "CITADELS_FRP_DOMAIN": "game.example"})
        self.assertIn('serverPort = 7000', config)
        self.assertIn('auth.token = "token\\\"quoted"', config)
        self.assertIn('transport.tls.enable = true', config)
        self.assertIn('localPort = 8787', config)
        self.assertIn('customDomains = ["game.example"]', config)

    def test_tcp_requires_remote_port_and_rejects_invalid_port(self):
        env = {"CITADELS_FRP_SERVER_ADDR": "relay", "CITADELS_FRP_TOKEN": "secret",
               "CITADELS_FRP_TYPE": "tcp"}
        with self.assertRaisesRegex(ValueError, "TCP 穿透"):
            build_config(8787, env)
        with self.assertRaisesRegex(ValueError, "SERVER_PORT 无效"):
            build_config(8787, {**env, "CITADELS_FRP_SERVER_PORT": "70000",
                                "CITADELS_FRP_REMOTE_PORT": "9999"})
        self.assertIn("remotePort = 443", build_config(8787,
            {**env, "CITADELS_FRP_REMOTE_PORT": "443"}))

    def test_disabled_manager_is_inert_and_reports_real_status(self):
        logs = []
        with tempfile.TemporaryDirectory() as directory:
            manager = FrpManager(8787, directory, logs.append, env={})
            self.assertEqual(manager.status(), {"enabled": False, "configured": False,
                "running": False, "type": "http", "domain": "", "remotePort": None})
            asyncio.run(manager.start())
            self.assertIn("未启用", logs[0])
            self.assertIsNone(manager.process)


if __name__ == "__main__":
    unittest.main()
