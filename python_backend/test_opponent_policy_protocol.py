"""Never silently train with old worker semantics or leak seat weights to live games."""
import io
import json
import threading
import unittest
from types import SimpleNamespace
from python_backend.native_worker import NativeMctsWorker

class OpponentPolicyProtocolTests(unittest.TestCase):
    def run_response(self, mode=None, opponents=None):
        response=dict(id='1',t='search_result',policy=[1.0],actionEncodingVersion=11,
                      supportedActionEncodingVersion=11,stateEncodingVersion=15)
        if mode: response['opponentPolicyMode']=mode
        worker=NativeMctsWorker.__new__(NativeMctsWorker)
        worker._lock=threading.Lock();worker._request_id=0
        worker.process=SimpleNamespace(poll=lambda:None,stdin=io.StringIO(),
                                       stdout=io.StringIO(json.dumps(response)+'\n'))
        result=worker.search(state={},particles=[],root_player_id='learner',legal_actions=[{}],
            particle_weights=[1],model_path='current.bin',model_version=1,profile='fast',
            architecture='entity-v6',device='cpu',simulations=20,max_depth=20,c_puct=1,
            dirichlet_alpha=0,dirichlet_epsilon=0,seed=7,opponent_policies=opponents)
        return result,json.loads(worker.process.stdin.getvalue())
    def test_old_worker_rejected_when_seat_policies_requested(self):
        with self.assertRaisesRegex(RuntimeError,'按席位策略'):
            self.run_response(opponents=[{'playerId':'opponent','modelPath':'history.bin'}])
    def test_new_worker_receives_exact_assignment(self):
        mapping=[dict(playerId='opponent',modelPath='history.bin',modelVersion=42,actionEncodingVersion=11)]
        _,request=self.run_response('seat-policy-sampling-v1',mapping)
        self.assertEqual(request['opponentPolicies'],mapping)
    def test_live_search_has_no_privileged_opponent_models(self):
        _,request=self.run_response()
        self.assertEqual(request['opponentPolicies'],[])

if __name__=='__main__':unittest.main()
