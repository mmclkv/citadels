"""Regression tests for determinized role queues shared with native MCTS."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test.python_determinize_reference import _rebuild_call_queue  # noqa: E402


class DeterminizeAlignmentTests(unittest.TestCase):
    def test_current_unplayed_role_is_not_duplicated(self):
        state = {
            "callIdx": 0,
            "callQueue": [{"charId": "king", "num": 4, "playerIdx": 0}],
            "players": [
                {"chars": ["king", "thief"], "played": []},
                {"chars": ["assassin"], "played": []},
            ],
        }

        _rebuild_call_queue(state)

        roles = [entry["charId"] for entry in state["callQueue"]]
        self.assertEqual(roles.count("king"), 1)
        self.assertEqual(set(roles), {"king", "thief", "assassin"})

    def test_previously_played_roles_are_not_reintroduced(self):
        state = {
            "callIdx": 1,
            "callQueue": [
                {"charId": "thief", "num": 2, "playerIdx": 0},
                {"charId": "king", "num": 4, "playerIdx": 1},
            ],
            "players": [
                {"chars": ["thief", "assassin"], "played": ["thief"]},
                {"chars": ["king", "bishop"], "played": []},
            ],
        }

        _rebuild_call_queue(state)

        roles = [entry["charId"] for entry in state["callQueue"]]
        self.assertEqual(roles.count("thief"), 1)
        self.assertEqual(roles.count("king"), 1)
        self.assertEqual(set(roles), {"thief", "king", "assassin", "bishop"})


if __name__ == "__main__":
    unittest.main()
