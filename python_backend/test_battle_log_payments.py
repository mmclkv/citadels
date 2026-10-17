"""Battle reports for deferred warrant construction and threat payments."""

import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from python_backend.server import PythonServer


class BattleLogPaymentTests(unittest.TestCase):
    def test_native_warrant_moves_announced_card_from_hand(self):
        card = {"uid": "tower-1", "name": "钟楼", "cost": 4}
        previous = {
            "reaction": {"kind": "magistrate", "playerIdx": 0,
                         "build": {"uid": card["uid"]}},
            "turn": {"playerIdx": 1},
            "players": [
                {"id": "m", "name": "行政官甲", "city": [], "hand": []},
                {"id": "b", "name": "建造者乙", "city": [], "hand": [card]},
            ],
        }
        for action in ({"type": "reaction", "name": "use"},
                       {"type": "reaction", "use": True},
                       {"type": "reaction", "effect": "use"}):
            with self.subTest(action=action):
                updated = copy.deepcopy(previous)
                updated["reaction"] = None
                updated["players"][1]["hand"] = []
                updated["players"][0]["city"] = [card]
                text = PythonServer._game_action_log_text(previous, action, updated)
                for detail in ("行政官甲", "建造者乙", "钟楼", "免费建入", "建造金币已退还"):
                    self.assertIn(detail, text)
                PythonServer._append_magistrate_confiscate_notice(previous, updated, action)
                self.assertEqual(updated["notices"][-1]["cardUid"], "tower-1")
                # Declining, or failing to transfer, must not report confiscation.
                declined = {"type": "reaction", "use": False}
                self.assertNotIn("没收", PythonServer._game_action_log_text(previous, declined, updated))
                self.assertNotIn("没收", PythonServer._game_action_log_text(previous, action, previous))

    def test_bribe_reports_half_rounded_down_before_role_bonus(self):
        for gold in (0, 1, 4, 5):
            with self.subTest(gold=gold):
                state = {"turn": {"playerIdx": 1, "pending": {"kind": "blackmailer_threat"}},
                         "players": [{"gold": 2}, {"gold": gold}]}
                updated = copy.deepcopy(state)
                updated["players"][1]["gold"] = gold - gold // 2 + 3
                text = PythonServer._game_action_log_text(
                    state, {"type": "blackmailer_bribe"}, updated)
                self.assertIn(f"支付了{gold // 2}枚金币作为贿金", text)
                self.assertNotIn("真威胁", text)
                self.assertNotIn("假威胁", text)


if __name__ == "__main__":
    unittest.main()
