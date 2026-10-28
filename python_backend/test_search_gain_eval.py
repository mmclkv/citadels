import unittest
from python_backend.search_gain_eval import LABELS, summarize


def row(block, rotation, winners=('mcts2000',), completed=True):
    if not completed:
        return dict(block=block, rotation=rotation, completed=False)
    ranks={label:i+1 for i,label in enumerate(reversed(LABELS))}
    return dict(block=block, rotation=rotation, completed=True, players=4,
        openingDealHash=str(block), results={label:dict(first=label in winners,
            winShare=1/len(winners) if label in winners else 0, rank=ranks[label],
            comparisons={other:float(ranks[label]<ranks[other]) for other in LABELS if other!=label})
            for label in LABELS}, decisions={label:2 for label in LABELS},
        instrumentation={label:dict(visits=2*{'direct':0,'mcts500':500,'mcts2000':2000}[label],
            searchSeconds=2,totalSeconds=3,expansions=20,particlesUsed=16) for label in LABELS})


class SearchGainSummaryTests(unittest.TestCase):
    def test_complete_openings_ties_and_deduplication(self):
        rows=[row(b,r,('mcts2000','mcts500') if b==0 else ('mcts2000',))
              for b in range(2) for r in range(3)]
        report=summarize(rows+[rows[0]])
        self.assertEqual(report['successfulGames'],6)
        self.assertEqual(report['completeOpeningBlocks'],2)
        self.assertEqual(report['ranking']['mcts2000']['winShare'],4.5)
        pair=report['paired']['mcts2000-direct']['metrics']
        self.assertEqual(pair['winShareDifference']['estimate'],.75)
        self.assertEqual(pair['pairwiseScore']['estimate'],1.)
        self.assertEqual(report['instrumentation']['mcts500']['totalVisits'],6000)
        self.assertEqual(report['byPlayers']['4']['direct']['games'],6)

    def test_partial_blocks_and_failed_games(self):
        report=summarize([row(0,0),row(1,0,completed=False)])
        self.assertEqual(report['failedGames'],1)
        self.assertEqual(report['completeOpeningBlocks'],0)
        self.assertEqual(report['paired'],{})

    def test_mismatched_opening_is_rejected(self):
        rows=[row(0,r) for r in range(3)]
        rows[-1]['openingDealHash']='different'
        with self.assertRaisesRegex(ValueError,'same opening'):
            summarize(rows)





import unittest
from python_backend.search_gain_eval import summarize,LABELS

def game(block,rotation,winner='mcts500',completed=True):
    results={label:{'first':label==winner,'winShare':float(label==winner),
                   'rank':1 if label==winner else 3,
                   'comparisons':{other:1 if label==winner else 0 if other==winner else .5 for other in LABELS if other!=label}}
             for label in LABELS}
    return {'block':block,'rotation':rotation,'completed':completed,'results':results,'players':4,'openingDealHash':str(block)}

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

if __name__=='__main__':unittest.main()
