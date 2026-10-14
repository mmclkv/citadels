import asyncio,copy,gzip,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from python_backend.replays import Recorder,ReplayStore,delta,apply_delta,recording_view
from test.python_game_reference import create_game,start_game

def fixture():
    state=create_game({'seed':17,'seats':[{'id':'a','name':'甲','isBot':False},{'id':'b','name':'乙','isBot':True}], 'charSetMode':'base','endDistricts':8})
    start_game(state)
    state['roomId']='TEST';state['createdAt']=123
    return {'id':'TEST','name':'测试录像','state':state,'seats':[{'resumeToken':'SECRET'}]}

class ReplayTests(unittest.TestCase):
    def test_nested_delta_roundtrip(self):
        a={'rows':[{'a':1,'gone':2},{'a':3}], 'log':['old'],'x':[1,2]}
        b={'rows':[{'a':2},{'a':3,'new':True}], 'log':['old','new'],'x':[5],'added':None}
        self.assertEqual(apply_delta(copy.deepcopy(a),delta(a,b)),b)
        self.assertEqual(delta(a,a),[])
    def test_completed_storage_roundtrip_and_restart_listing(self):
        room=fixture();r=Recorder(room,{'commit':'test'})
        expected=[]
        r.observe(room['state']);expected.append(recording_view(room['state'])[0])
        room['state']['players'][0]['gold']+=2
        room['state']['log'].append({'text':'领取金币','type':'info','round':1,'i':1})
        r.observe(room['state'],'a',{'type':'gold'});expected.append(recording_view(room['state'])[0])
        r.observe(room['state']);self.assertEqual(len(r.steps),2)
        with tempfile.TemporaryDirectory() as folder:
            store=ReplayStore(folder)
            with self.assertRaises(ValueError):store.save(r)
            self.assertEqual(store.listing()['total'],0)
            room['state']['phase']='gameover';room['state']['winner']=0
            r.observe(room['state']);expected.append(recording_view(room['state'])[0])
            store.save(r);store.save(r)
            loaded=store.read(r.id);current=loaded['initial']
            for i,step in enumerate(loaded['steps']):
                current=apply_delta(current,step['d']);self.assertEqual(current,expected[i])
            raw=json.dumps(loaded);self.assertNotIn('SECRET',raw);self.assertNotIn('resumeToken',raw)
            self.assertLess(len(gzip.compress(raw.encode())),len(raw.encode())/3)
            self.assertEqual(ReplayStore(folder).listing()['total'],1)
            self.assertEqual(ReplayStore(folder).listing(offset=1)['replays'],[])
            next(Path(folder).glob('*.meta.json')).unlink()
            self.assertEqual(ReplayStore(folder).listing()['total'],1)
    def test_recorded_changes_are_immutable(self):
        room=fixture();r=Recorder(room,{})
        r.observe(room['state'])
        room['state']['config']['extra']={'nested':[1]};r.observe(room['state'])
        room['state']['config']['extra']['nested'][0]=2;r.observe(room['state'])
        state=apply_delta(copy.deepcopy(r.initial),r.steps[1]['d'])
        self.assertEqual(state['config']['extra']['nested'],[1])

    def test_private_logs_excluded_and_safe_identifiers(self):
        room=fixture();room['state']['log'].append({'i':99,'text':'private secret','visibleTo':['a'],'type':'info'})
        r=Recorder(room,{});r.observe(room['state'])
        self.assertNotIn('private secret',json.dumps(r.steps))
        with tempfile.TemporaryDirectory() as folder:
            for identity in ('../../secret','%2e%2e/secret','abc'):
                with self.assertRaises(ValueError):ReplayStore(folder).read(identity)
    def test_server_auto_capture_and_publish_once(self):
        from python_backend.server import PythonServer
        server=PythonServer.__new__(PythonServer);server.release={'commit':'test'};server.logs=[]
        with tempfile.TemporaryDirectory() as folder:
            server.replays=ReplayStore(folder);room=fixture()
            asyncio.run(server._record_replay(room))
            self.assertEqual(server.replays.listing()['total'],0)
            room['state']['phase']='gameover';room['state']['winner']=0
            asyncio.run(server._record_replay(room,'a',{'type':'end_turn'}))
            asyncio.run(server._record_replay(room))
            self.assertEqual(server.replays.listing()['total'],1)
            room['state']=None;asyncio.run(server._record_replay(room));self.assertNotIn('_replay',room)

if __name__=='__main__':unittest.main()
