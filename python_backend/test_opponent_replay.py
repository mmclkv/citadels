import unittest
import numpy as np
from python_backend.opponent_replay import OpponentReplayBuffer

def plan(n=4,family='heuristic'):
    return dict(players=n,main=n if family=='current' else 1,
                historical=n-1 if family=='history' else 0,heuristic=n-1 if family=='heuristic' else 0)
def rows(game,count=10):
    return [dict(game=game,row=i,state=np.zeros(4,dtype=np.float32)) for i in range(count)]

class OpponentReplayTests(unittest.TestCase):
    def test_total_capacity_recent_retention_and_long_term_coverage(self):
        buffer=OpponentReplayBuffer(24,seed=7)
        for i in range(300):buffer.add_game(rows(i),plan(4,'current' if i>=30 else 'heuristic'))
        self.assertEqual(buffer.game_count,24)
        self.assertEqual([g[1][0]['game'] for g in buffer.recent],list(range(288,300)))
        old=[g for bucket in buffer.archive.values() for g in bucket]
        self.assertEqual(len(old),12)
        self.assertEqual(sum(g[0][1]=='heuristic' for g in old),6)
        self.assertTrue(any(g[1][0]['game']<30 for g in old))
        self.assertEqual(buffer.samples,240)
        self.assertEqual(buffer.bytes,240*16)

    def test_balanced_sampling_does_not_favor_long_games_and_has_no_duplicates(self):
        buffer=OpponentReplayBuffer(6)
        buffer.add_game(rows(0,1000),plan(4,'heuristic'))
        buffer.add_game(rows(1,10),plan(4,'heuristic'))
        buffer.add_game(rows(2,20),plan(8,'history'))
        sampled=buffer.sample(18,np.random.default_rng(2))
        counts={i:sum(r['game']==i for r in sampled) for i in range(3)}
        self.assertEqual(counts[2],9)
        self.assertEqual(sorted([counts[0],counts[1]]),[4,5])
        self.assertEqual(len({(r['game'],r['row']) for r in sampled}),18)
        self.assertEqual(sampled,buffer.sample(18,np.random.default_rng(2)))

    def test_half_replay_from_archive_and_capacity_edges(self):
        buffer=OpponentReplayBuffer(8)
        for i in range(50):buffer.add_game(rows(i),plan())
        sampled=buffer.sample(20,np.random.default_rng(5))
        self.assertEqual(sum(r['game']>=46 for r in sampled),10)
        for capacity in (0,1,2,3):
            b=OpponentReplayBuffer(capacity)
            for i in range(20):b.add_game(rows(i,1),plan(4,'history' if i%2 else 'heuristic'))
            self.assertLessEqual(b.game_count,capacity)
            output=b.sample(999,np.random.default_rng(3))
            self.assertEqual(len(output),b.samples)
            self.assertEqual(len({(r['game'],r['row']) for r in output}),len(output))
            self.assertEqual(b.sample(0,np.random.default_rng(3)),[])
            self.assertFalse(b.add_game([]))

if __name__=='__main__':unittest.main()
