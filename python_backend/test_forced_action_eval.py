import io,json,threading,unittest
from types import SimpleNamespace
from python_backend.native_worker import NativeMctsWorker
from python_backend.forced_action_eval import summarize

class ForcedSwitchProtocolTests(unittest.TestCase):
    def request(self, enabled, echo):
        reply=dict(id='1',t='search_result',policy=[1.],actionEncodingVersion=12,
                   supportedActionEncodingVersion=12,stateEncodingVersion=16)
        if echo is not None:reply['fastForwardSingleActions']=echo
        worker=NativeMctsWorker.__new__(NativeMctsWorker)
        worker._lock=threading.Lock();worker._request_id=0
        worker.process=SimpleNamespace(poll=lambda:None,stdin=io.StringIO(),
            stdout=io.StringIO(json.dumps(reply)+'\n'))
        worker.search(state={},particles=[],root_player_id='p0',legal_actions=[{}],
            particle_weights=[1],model_path='same.bin',model_version=1,profile='fast',
            architecture='entity-v6',device='cpu',simulations=500,max_depth=700,c_puct=1,
            dirichlet_alpha=0,dirichlet_epsilon=0,seed=7,fast_forward_single_actions=enabled)
        return json.loads(worker.process.stdin.getvalue())
    def test_both_switch_values_are_explicit(self):
        for enabled in (False,True):
            self.assertIs(self.request(enabled,enabled)['fastForwardSingleActions'],enabled)
    def test_unsupported_disabled_switch_is_rejected(self):
        for echo in (None,True):
            with self.assertRaisesRegex(RuntimeError,'关闭单动作'):
                self.request(False,echo)

class PairedSummaryTests(unittest.TestCase):
    def row(self, block, rotation, score, fast_first, base_first):
        share=.5 if fast_first and base_first else 1.
        return dict(block=block,rotation=rotation,completed=True,
            results={'baseline':dict(first=base_first,winShare=share if base_first else 0,
                rank=2,pairwise={'fast_forward':1-score}),
                'fast_forward':dict(first=fast_first,winShare=share if fast_first else 0,
                rank=1,pairwise={'baseline':score})},
            decisions={'baseline':1,'fast_forward':1},
            instrumentation={x:dict(visits=500,expansions=600,particlesUsed=68,
                searchSeconds=2,totalSeconds=3) for x in ('baseline','fast_forward')})
    def test_championship_ties_and_paired_blocks(self):
        rows=[self.row(0,0,1,True,False),self.row(0,1,0,False,True),
              self.row(1,0,.5,True,True),self.row(1,1,1,True,False)]
        report=summarize(rows,1000)
        self.assertEqual(report['successfulGames'],4)
        self.assertEqual(report['completeOpeningBlocks'],2)
        self.assertEqual(report['results']['fast_forward']['firsts'],3)
        self.assertEqual(report['results']['fast_forward']['winShare'],2.5)
        self.assertEqual(report['paired']['winShareDifference']['estimate'],.25)
        self.assertEqual(report['paired']['pairwiseScore']['estimate'],.625)
        self.assertEqual(report['instrumentation']['fast_forward']['totalVisits'],2000)
    def test_unpaired_games_and_failures_are_not_independent_pairs(self):
        rows=[self.row(0,0,1,True,False),dict(block=1,rotation=0,completed=False)]
        report=summarize(rows,100)
        self.assertEqual(report['successfulGames'],1)
        self.assertEqual(report['failedGames'],1)
        self.assertEqual(report['completeOpeningBlocks'],0)
        self.assertEqual(report['paired'],{})

if __name__=='__main__':unittest.main()
