"""Catalog, visible choices and concealed building information regressions."""
import json
import os
from pathlib import Path
import re
import subprocess
import unittest

from python_backend import cards
from python_backend.server import PythonServer
from python_backend.views import _pending_public, sanitize
from test.python_game_reference import create_game, _new_turn

ROOT = Path(__file__).resolve().parents[1]

class DistrictExpansionTests(unittest.TestCase):
    def test_action_views_for_owner_opponent_and_spectator(self):
        state = create_game({"seed": 1, "endDistricts": 8, "charSetMode": "base",
                             "seats": [{"id": "p0", "name": "甲"}, {"id": "p1", "name": "乙"}]})
        state["phase"] = "action"
        state["players"][0]["chars"] = ["assassin"]
        state["players"][1]["chars"] = ["thief"]
        state["turn"] = _new_turn({"playerIdx": 0, "charId": "assassin", "num": 1}, "normal")
        for viewer in ("p0", "p1", None):
            with self.subTest(viewer=viewer):
                view = sanitize(state, viewer)
                self.assertEqual(view["turn"]["charId"], "assassin")
                self.assertEqual(view["players"][0]["revealedCharId"], "assassin")
                if viewer != "p1":
                    self.assertIsNone(view["players"][1]["revealedCharId"])
        state["turn"].update({"phase": "setup", "charId": "", "num": 0,
                                "pending": {"kind": "theater_exchange", "queue": [0]}})
        state["effects"]["blackmailer"] = {"playerIdx": 1, "nums": [1], "done": [], "revealed": []}
        state["effects"]["magistrate"] = {"playerIdx": 1, "nums": [1]}
        for viewer in ("p0", "p1", None):
            with self.subTest(setup_viewer=viewer):
                view = sanitize(state, viewer)
                self.assertIsNone(view["turn"]["charId"])
                self.assertIsNone(view["turn"]["charNum"])
                self.assertEqual(view["turn"]["charName"], "剧院交换")
                if viewer != "p0":
                    self.assertIsNone(view["players"][0]["revealedCharId"])
                    self.assertIsNone(view["players"][0]["threat"])
                    self.assertIsNone(view["players"][0]["warrant"])

    def test_catalog_matches_browser_and_has_all_buildings(self):
        script = (ROOT / "src/cards.js").read_text(encoding="utf-8")
        browser = json.loads(re.search(r"const DISTRICTS = (\[.*?\]);", script, re.S).group(1))
        self.assertEqual(browser, cards.DISTRICTS)
        self.assertEqual(len(browser), 54)
        self.assertEqual(sum(c["count"] for c in browser), 92)
        self.assertEqual(len({c["en"] for c in browser}), 54)
        self.assertEqual(next(c["cost"] for c in browser if c["en"] == "Observatory"), 4)

    def test_all_building_choices_have_readable_labels(self):
        state = {"players": [{"id": "p0", "name": "你", "hand": [{"uid": "d70", "name": "军械库"}], "city": []},
                             {"id": "p1", "name": "玩家二", "hand": [], "city": []}],
                 "turn": {"pending": {"cards": [{"uid": "d80", "name": "灯塔"}]}}}
        modes = ["framework", "necropolis", "armory", "thieves_begin", "thieves_discard", "thieves_pay", "thieves_cancel",
                 "lighthouse_pick", "lighthouse_skip", "bell_enable", "bell_skip", "ballroom_thanks", "ballroom_skip", "theater_swap", "theater_skip"]
        for mode in modes:
            action = {"type": "district_effect", "name": mode, "uid": "0" if mode == "theater_swap" else "d70", "target": "p1"}
            self.assertNotEqual(PythonServer._native_action_view(state, action)["label"], "district_effect")

    def test_lighthouse_cards_are_private_and_owner_is_decision_actor(self):
        pending = {"kind": "lighthouse", "targetIdx": 1, "cards": [{"uid": "d1", "name": "建筑", "en": "District", "color": "green", "cost": 1, "desc": ""}]}
        self.assertEqual(_pending_public(pending, False)["cards"], [])
        self.assertEqual(len(_pending_public(pending, True)["cards"]), 1)
        app = PythonServer.__new__(PythonServer)
        state = {"phase": "action", "players": [{"id": "builder"}, {"id": "owner"}], "turn": {"playerIdx": 0, "pending": pending}}
        self.assertEqual(app._bot_actor(state), "owner")
        state["turn"]["pending"] = {"kind": "theater_exchange", "queue": [1, 0]}
        self.assertEqual(app._bot_actor(state), "owner")

    def test_secret_vault_does_not_leak_through_public_totals(self):
        state = create_game({"seed": 1, "endDistricts": 8, "charSetMode": "base",
                             "seats": [{"id": "p0", "name": "甲"}, {"id": "p1", "name": "乙"}]})
        vault = next(c for c in cards.DISTRICTS if c["en"] == "Secret Vault")
        state["players"][0]["hand"] = [{**vault, "uid": "vault", "purpleEffect": "secretVault"}]
        state["scores"] = [{"playerIdx": 0, "base": 0, "bonus": 3, "total": 3,
                            "detail": [{"label": "建筑总分", "value": 0},
                                       {"label": "秘密宝库加成奖励", "value": 3}]}]
        self.assertEqual(sanitize(state, "p1")["scores"][0]["total"], 0)
        self.assertEqual(sanitize(state, "p0")["scores"][0]["total"], 3)
        self.assertEqual(sanitize(state, None)["scores"][0]["detail"],
                         [{"label": "建筑总分", "value": 0}])
        self.assertEqual(sanitize(state, "p0")["scores"][0]["detail"][-1]["value"], 3)
        state["phase"] = "gameover"
        self.assertEqual(sanitize(state, "p1")["scores"][0]["total"], 3)
        self.assertEqual(sanitize(state, "p1")["scores"][0]["detail"][-1]["label"], "秘密宝库加成奖励")
        self.assertEqual(state["scores"][0]["total"], 3)

    @unittest.skipUnless(os.environ.get("CITADELS_TEST_DISTRICT_PROBE"), "Compiled district probe required")
    def test_native_rule_combinations(self):
        result = subprocess.run([os.environ["CITADELS_TEST_DISTRICT_PROBE"], str(ROOT / "python_backend/catalog.json")], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("checks passed", result.stdout)

if __name__ == "__main__":
    unittest.main()
