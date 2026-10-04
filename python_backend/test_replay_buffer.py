"""Game-count retention must not be silently overridden by a byte cap."""
import unittest
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.training_runtime import RecentReplayBuffer


class ReplayBufferTests(unittest.TestCase):
    def test_retains_configured_games_above_old_byte_limit(self):
        buffer = RecentReplayBuffer(max_games=128)
        # Broadcast views exercise byte accounting without allocating 512 MiB.
        state = np.broadcast_to(np.zeros(1, dtype=np.float32), (1024 * 1024,))
        for game in range(128):
            self.assertTrue(buffer.add_game([{"state": state, "game": game}]))
        self.assertEqual(buffer.game_count, 128)
        self.assertEqual(buffer.samples, 128)
        self.assertEqual(buffer.bytes, 512 * 1024 * 1024)

    def test_single_large_game_is_not_rejected(self):
        state = np.broadcast_to(np.zeros(1, dtype=np.float32), (70 * 1024 * 1024,))
        buffer = RecentReplayBuffer(max_games=2)
        self.assertTrue(buffer.add_game([{"state": state}]))
        self.assertGreater(buffer.bytes, 256 * 1024 * 1024)

    def test_eviction_and_sampling_keep_only_recent_games(self):
        buffer = RecentReplayBuffer(max_games=2)
        for game in range(4):
            buffer.add_game([{"state": np.zeros(game + 1, dtype=np.float32), "game": game}])
        self.assertEqual(buffer.game_count, 2)
        self.assertEqual(buffer.samples, 2)
        self.assertEqual(buffer.bytes, (3 + 4) * 4)
        rows = buffer.sample(100, np.random.default_rng(42))
        self.assertEqual({row["game"] for row in rows}, {2, 3})

    def test_zero_capacity_and_empty_games(self):
        buffer = RecentReplayBuffer(max_games=0)
        self.assertFalse(buffer.add_game([{"state": np.zeros(1, dtype=np.float32)}]))
        self.assertFalse(buffer.add_game([]))
        self.assertEqual(buffer.game_count, 0)
        self.assertEqual(buffer.bytes, 0)
        self.assertEqual(buffer.sample(10, np.random.default_rng(42)), [])


if __name__ == "__main__":
    unittest.main()
