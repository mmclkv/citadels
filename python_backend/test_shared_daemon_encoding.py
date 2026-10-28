import os,queue,struct,subprocess,sys,tempfile,threading,time,unittest,uuid
from pathlib import Path
from multiprocessing import shared_memory
import numpy as np
import torch
from training.gpu_trainer import create_model
from python_backend.training_runtime import _entity_forward_probe_inputs
ROOT=Path(__file__).resolve().parents[1]

class SharedDaemonEncodingTests(unittest.TestCase):
    def test_legacy_default_and_explicit_v16_binary_inference(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as directory:
            for version in (15,16):
                with self.subTest(version=version):
                    model=create_model('entity-v6','fast',version).eval()
                    flat=Path(directory)/f'model-{version}.bin';model.save_flat(flat)
                    name='citadels-encoding-'+uuid.uuid4().hex
                    args=[sys.executable,str(ROOT/'training/shared_inference_daemon.py'),'--name',name,
                          '--profile','fast','--device','cpu','--model',str(flat),'--slots','1','--slot-bytes','65536']
                    if version==16:args+=['--state-encoding-version','16']
                    env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}
                    proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,text=True)
                    shm=None
                    try:
                        messages=queue.Queue()
                        threading.Thread(target=lambda:messages.put(proc.stdout.readline()),daemon=True).start()
                        self.assertEqual(messages.get(timeout=30).strip(),'READY')
                        shm=shared_memory.SharedMemory(name=name)
                        state,actions=_entity_forward_probe_inputs(version)[0]
                        if version==16:state[2054:]=.2
                        payload=struct.pack('<IIIII',1,1,len(state),actions.shape[1],len(actions))+state.tobytes()+actions.tobytes()
                        shm.buf[40:40+len(payload)]=payload
                        struct.pack_into('<I',shm.buf,20,len(payload));struct.pack_into('<I',shm.buf,16,2)
                        deadline=time.monotonic()+20
                        while struct.unpack_from('<I',shm.buf,16)[0]!=3 and time.monotonic()<deadline:time.sleep(.01)
                        self.assertEqual(struct.unpack_from('<I',shm.buf,16)[0],3)
                        size=struct.unpack_from('<I',shm.buf,24)[0];reply=bytes(shm.buf[40:40+size])
                        self.assertEqual(struct.unpack_from('<II',reply),(2,1))
                        count=struct.unpack_from('<I',reply,8)[0];self.assertEqual(count,len(actions))
                        probabilities=np.frombuffer(reply,dtype='<f4',count=count,offset=12)
                        values=np.frombuffer(reply,dtype='<f4',count=8,offset=12+4*count)
                        with torch.inference_mode():logits,expected=model(torch.tensor(state)[None],torch.tensor(actions)[None])
                        np.testing.assert_allclose(probabilities,logits.softmax(-1).numpy()[0],atol=1e-5,rtol=1e-5)
                        np.testing.assert_allclose(values,expected.numpy()[0],atol=1e-5,rtol=1e-5)
                    finally:
                        proc.terminate();proc.wait(timeout=10)
                        proc.stdout.close();proc.stderr.close()
                        if shm is not None:shm.close();shm.unlink()
