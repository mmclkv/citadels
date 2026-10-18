import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from python_backend.server import PythonServer
from python_backend.test_server import _ReferenceWorkerManager


class BeliefApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {'CITADELS_ADMIN_FILE':str(Path(self.directory.name)/'admin.json'),
                                     'CITADELS_TRAINING_DATA_DIR':self.directory.name}):
            self.app=PythonServer(_ReferenceWorkerManager())
        self.listener=await asyncio.start_server(self.app.handle,'127.0.0.1',0)
        self.port=self.listener.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.app.belief_training.stop()
        self.listener.close();await self.listener.wait_closed()
        self.directory.cleanup()

    async def request(self,path,method='GET',body=None):
        reader,writer=await asyncio.open_connection('127.0.0.1',self.port)
        payload=json.dumps(body).encode() if body is not None else b''
        writer.write(f'{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(payload)}\r\n\r\n'.encode()+payload)
        await writer.drain();raw=await reader.read()
        writer.close();await writer.wait_closed()
        header,data=raw.split(b'\r\n\r\n',1)
        return int(header.split()[1]),json.loads(data)

    async def test_status_methods_local_only_and_path_validation(self):
        code,data=await self.request('/api/belief/status')
        self.assertEqual(code,200);self.assertFalse(data['running']);self.assertEqual(data['checkpoints'],[])
        self.assertEqual((await self.request('/api/belief/start'))[0],405)
        with patch('python_backend.server._is_loopback_ip',return_value=False):
            self.assertEqual((await self.request('/api/belief/stop','POST',{}))[0],403)
        code,data=await self.request('/api/belief/activate','POST',{'checkpoint':'../belief-private.npz'})
        self.assertEqual(code,400)
        self.assertEqual((await self.request('/api/belief/disable','POST',{}))[0],200)

    async def test_policy_and_belief_trainers_are_mutually_exclusive(self):
        self.app.training._status['running']=True
        code,data=await self.request('/api/belief/start','POST',{})
        self.assertEqual(code,400);self.assertIn('策略训练',data['error'])
        self.app.training._status['running']=False
        self.app.belief_training._status['running']=True
        code,data=await self.request('/api/training/start','POST',{})
        self.assertEqual(code,400);self.assertIn('信念训练',data['error'])
        self.app.belief_training._status['running']=False


if __name__=='__main__':unittest.main()
