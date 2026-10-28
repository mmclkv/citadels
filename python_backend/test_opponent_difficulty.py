import unittest
from python_backend.opponent_difficulty import heuristic_levels

class OpponentDifficultyTests(unittest.TestCase):
    def test_random_levels_are_explicit_repeatable_and_diverse(self):
        rows=[heuristic_levels("random",8,seed) for seed in range(30)]
        self.assertEqual(rows,[heuristic_levels("random",8,seed) for seed in range(30)])
        self.assertEqual(set(x for row in rows for x in row),{"easy","normal","hard"})
        self.assertGreater(len({tuple(row) for row in rows}),10)
    def test_fixed_levels_are_preserved(self):
        for level in ("easy","normal","hard"):
            self.assertEqual(heuristic_levels(level,8,17),[level]*8)
        with self.assertRaises(ValueError): heuristic_levels("invalid",4,17)
