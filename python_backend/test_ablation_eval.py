import unittest
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from collections import Counter, defaultdict
from python_backend.ablation_eval import schedule, summarize


class AblationTests(unittest.TestCase):
    def test_monitoring_file_lock_cannot_abort_a_game(self):
        from python_backend import ablation_eval as arena
        state=dict(scores=[dict(total=x) for x in (10,3,2,1)],round=1)
        engine=SimpleNamespace(create_game=lambda *a,**kw:state,
            current=lambda *a:dict(gameOver=True),snapshot=lambda *a:state,
            close_game=lambda *a:None)
        policy=SimpleNamespace(belief_policy=SimpleNamespace(histories={},error='',last=None))
        case=dict(id='file-lock',key='b0h0d0',belief=False,history=False,dynamic=False,
            players=4,seat=0,seed=1,crown=0)
        with tempfile.TemporaryDirectory() as folder:
            context=(dict(output=folder,budgetMs=5000),engine,None,policy,policy)
            with patch.object(arena,'CONTEXT',context), patch.object(arena,'atomic_json',side_effect=PermissionError('file locked')):
                row=arena.run_case(case)
        self.assertTrue(row['complete'],row)
        self.assertTrue(row['first'])
        self.assertEqual(row['stats']['progressWriteFailures'],1)

    def test_balanced_paired_factorial_schedule(self):
        rows=schedule()
        self.assertEqual(rows,schedule())
        self.assertEqual(len(rows),800)
        self.assertEqual(len({r['id'] for r in rows}),800)
        self.assertEqual(set(Counter(r['key'] for r in rows).values()),{100})
        self.assertEqual(set(Counter((r['key'],r['players']) for r in rows).values()),{20})
        blocks=defaultdict(list)
        for r in rows:blocks[r['opening']].append(r)
        self.assertEqual(len(blocks),100)
        for block in blocks.values():
            self.assertEqual(len(block),8)
            for field in ('seed','seat','crown','players','cluster','swap'):
                self.assertEqual(len({r[field] for r in block}),1)
        self.assertNotEqual(schedule(seed=19),rows)
        with self.assertRaises(ValueError):schedule(15)

    def test_factorial_contrasts_and_cluster_bootstrap(self):
        rows=[]
        for case in schedule(10):
            b,h,d=[int(case[x]) for x in ('belief','history','dynamic')]
            value=2*b+3*h+5*d+7*b*h
            rows.append(dict(case,complete=True,first=value/32,winShare=value/64,
                score=value,rank=1,stats=dict(searches=1,visits=10,worlds=4,samplingMs=1,
                budgetOverruns=0,learnedScored=b,nativePrivatePhase=0)))
        result=summarize(rows,bootstrap=100)
        self.assertEqual(result['matchedClusters'],5)
        for factor,expected in [('B',5.5),('H',6.5),('D',5),('B*H',7),('B*D',0),('H*D',0),('B*H*D',0)]:
            self.assertAlmostEqual(result['effects']['score'][factor]['mean'],expected)
        # Losing just one group invalidates the whole matched seed-pair for
        # contrasts, while its completed games remain in descriptive counts.
        rows[0]['complete']=False
        result=summarize(rows,bootstrap=100)
        self.assertEqual(result['failures'],1)
        self.assertEqual(result['matchedClusters'],4)


if __name__=='__main__':unittest.main()
