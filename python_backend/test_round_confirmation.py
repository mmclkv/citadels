"""Round acknowledgement regressions against the authoritative C++ IPC worker.

Set CITADELS_TEST_GAME_ENGINE to a freshly compiled game_engine executable.
"""

import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from python_backend.game_engine_worker import GameEngineWorker


@unittest.skipUnless(os.environ.get("CITADELS_TEST_GAME_ENGINE"),
                     "Compiled test game engine required")
class RoundConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.worker = GameEngineWorker(
            os.environ["CITADELS_TEST_GAME_ENGINE"],
            env=dict(os.environ, CITADELS_HEURISTIC_MCTS_ENABLED="0"))
        self.addCleanup(self.worker.close)
        self.state = self.worker.create_game({
            "seed": 92, "endDistricts": 8, "charSetMode": "base",
            "catalog": json.loads((ROOT / "python_backend/catalog.json").read_text(
                encoding="utf-8")),
            "seats": [{"id": "p0", "isBot": False},
                      {"id": "p1", "isBot": False},
                      {"id": "p2", "isBot": True, "botLevel": "normal"}],
        }, "confirmation")

    def apply(self, player_id, action):
        self.state = self.worker.apply(game_id="confirmation", player_id=player_id,
                                       action=action)
        return self.state

    def reach_round_confirmation(self):
        for step in range(300):
            if self.state.get("roundConfirm"):
                return
            actor = self.worker.current("confirmation")["playerId"]
            action = self.worker.decide_npc(game_id="confirmation", player_id=actor,
                                            seed=step + 1)
            self.assertIsNotNone(action)
            self.apply(actor, action)
        self.fail("First round did not reach confirmation")

    def test_humans_and_bot_confirm_in_reverse_seat_order(self):
        self.reach_round_confirmation()
        round_number = self.state["round"]
        for player_id, expected in (("p2", [False, False, True]),
                                    ("p1", [False, True, True])):
            actions = self.worker.legal_actions(game_id="confirmation", player_id=player_id)
            self.assertEqual(actions["actions"], [{"type": "confirm_round"}])
            self.apply(player_id, {"type": "confirm_round"})
            self.assertEqual(self.state["roundConfirm"]["confirmed"], expected)
            self.assertEqual(self.state["round"], round_number)

        # An acknowledged player cannot confirm twice or advance the round early.
        before = self.worker.snapshot("confirmation")
        with self.assertRaises(RuntimeError):
            self.apply("p2", {"type": "confirm_round"})
        self.assertEqual(self.worker.snapshot("confirmation"), before)
        self.assertEqual(self.worker.legal_actions(
            game_id="confirmation", player_id="p2")["actions"], [])

        self.apply("p0", {"type": "confirm_round"})
        self.assertIsNone(self.state["roundConfirm"])
        self.assertEqual(self.state["phase"], "draft")
        self.assertEqual(self.state["round"], round_number + 1)

    def test_confirmation_does_not_bypass_normal_turn_order(self):
        actor = self.worker.current("confirmation")["playerId"]
        other = next(p["id"] for p in self.state["players"] if p["id"] != actor)
        action = self.worker.legal_actions(
            game_id="confirmation", player_id=actor)["actions"][0]
        before = self.worker.snapshot("confirmation")
        for invalid_action in (action, {"type": "confirm_round"}):
            with self.assertRaisesRegex(RuntimeError, "不是该玩家的行动时机"):
                self.apply(other, invalid_action)
            self.assertEqual(self.worker.snapshot("confirmation"), before)

    def test_round_confirmation_rejects_other_actions_and_unknown_players(self):
        self.reach_round_confirmation()
        before = self.worker.snapshot("confirmation")
        for player_id, action in (("p2", {"type": "end_turn"}),
                                  ("spectator", {"type": "confirm_round"})):
            with self.assertRaises(RuntimeError):
                self.apply(player_id, action)
            self.assertEqual(self.worker.snapshot("confirmation"), before)


if __name__ == "__main__":
    unittest.main()
