import unittest
from python_backend.search_gain_eval import summarize,LABELS

def game(block,rotation,winner='mcts500',completed=True):
    results={label:{'first':label==winner,'winShare':float(label==winner),
                   'rank':1 if label==winner else 3,
                   'comparisons':{other:1 if label==winner else 0 if other==winner else .5 for other in LABELS if other!=label}}
             for label in LABELS}
    return {'block':block,'rotation':rotation,'completed':completed,'results':results}

class SearchGainTests(unittest.TestCase):
    def test_same_table_wins_and_cluster_intervals(self):
        rows=[game(b,r) for b in range(3) for r in range(3)]+[game(3,0,completed=False)]
        stats=summarize(rows)
        self.assertEqual(stats['successfulGames'],9);self.assertEqual(stats['failedGames'],1)
        self.assertEqual(stats['ranking']['mcts500']['firsts'],9)
        self.assertEqual(stats['ranking']['mcts500']['pairwise']['direct'],1)
        self.assertEqual(stats['paired']['mcts500-direct']['openingBlocks'],3)
        self.assertEqual(stats['paired']['mcts500-direct']['95ClusterBootstrap'],[1.,1.])
    def test_incomplete_rotation_blocks_are_not_treated_as_independent_openings(self):
        stats=summarize([game(0,r) for r in range(3)]+[game(1,0)])
        self.assertEqual(stats['successfulGames'],4)
        self.assertEqual(stats['paired'],{})
    def test_empty_results_do_not_invent_ratings(self):
        stats=summarize([])
        self.assertEqual(stats['ranking']['direct']['games'],0)
        self.assertIsNone(stats['ranking']['direct']['meanRank'])
