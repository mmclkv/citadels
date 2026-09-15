'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { PolicyValueNetwork, mulberry32 } = require('./neural-policy.js');
const { runSelfPlayGame } = require('./train.js');
const { BatchEvaluator } = require('./evaluator.js');
const { NativeSearchClient } = require('./native-search.js');

const model = new PolicyValueNetwork({ profile: workerData.config.profile,
  stateSize: 672, actionSize: 256, seed: workerData.config.seed ^ (workerData.workerId * 2654435761) });
let modelVersion = -1;
let stopping = false;

// MCTS GPU 评估：worker 不持有 PyTorch，把 BatchEvaluator 的 forwardBatch 转发给主进程。
// 主进程用同一把 FIFO（torch-bridge）排队发给 Python 子进程，结果再回写到 worker。
// 这里挂一个 id 映射，避免多个并发 forward 互相错位（虽然 torch-bridge 是 FIFO，
// 但评测阶段会同时存在多 worker 并发，多个 in-flight 请求并存是常态）。
const forwardPending = new Map();
let forwardId = 0;
function ipcForwardBatch(stateVectors, actionVectorsList) {
  const id = ++forwardId;
  const payload = {
    id,
    stateVectors: stateVectors.map(s => Array.from(s)),
    actionVectorsList: actionVectorsList.map(group => group.map(a => Array.from(a)))
  };
  parentPort.postMessage({ type: 'forwardBatch', payload });
  return new Promise((resolve, reject) => {
    forwardPending.set(id, { resolve, reject });
  });
}

let mctsEvaluator = null;
let nativeSearch = null;
function getMctsEvaluator() {
  if (!mctsEvaluator) {
    mctsEvaluator = new BatchEvaluator({
      forwardBatch: ipcForwardBatch,
      sanitize: require('../src/engine.js').sanitize,
      encodeState: require('./train.js').encodeState,
      encodeAction: require('./train.js').encodeAction,
      batchSize: workerData.config.mctsBatchSize || 32,
      // 0 是合法值（不限制等待），用 ?? 保留 0，仅当未定义时回退 1
      maxWaitMs: workerData.config.mctsMaxWaitMs ?? 1,
      cacheSize: workerData.config.mctsCacheSize || 65536
    });
  }
  return mctsEvaluator;
}

function loadModel(filename) {
  const data = fs.readFileSync(filename);
  const flat = new Float32Array(data.byteLength / 4);
  for (let i = 0; i < flat.length; i++) flat[i] = data.readFloatLE(i * 4);
  model.importFlat(flat);
}

function getNativeSearch() {
  if (!nativeSearch) nativeSearch = new NativeSearchClient({
    root: require('node:path').join(__dirname, '..'),
    executable: workerData.config.nativeSearchWorker,
    simulations: workerData.config.mctsSimulations || 1,
    maxDepth: workerData.config.mctsMaxDepth || 200,
    batchSize: workerData.config.mctsBatchSize || 32,
    cPuct: workerData.config.mctsC_puct || 1,
    seed: workerData.config.seed ^ (workerData.workerId * 2654435761),
    gpuEvaluator: workerData.config.mctsEvaluator === 'gpu',
    python: require('node:path').join(__dirname, '..', '.python', 'python.exe'),
    script: require('node:path').join(__dirname, 'gpu_trainer.py'),
    profile: workerData.config.profile,
    device: workerData.config.device || (workerData.config.backend === 'cpu' ? 'cpu' : 'cuda'),
    inferenceBackend: workerData.config.nativeInferenceBackend || 'python-binary',
    sharedMemoryName: workerData.config.sharedMemoryName || '',
    sharedMemorySlots: workerData.config.sharedMemorySlots || 8,
    sharedMemorySlotBytes: workerData.config.sharedMemorySlotBytes || 8 * 1024 * 1024
  });
  return nativeSearch;
}

parentPort.on('message', async message => {
  if (message.type === 'stop') { stopping = true; return; }
  if (message.type === 'forwardBatchResult') {
    const pending = forwardPending.get(message.id);
    if (!pending) return;
    forwardPending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return;
  }
  if (message.type !== 'run') return;
  stopping = false;
  try {
    if (modelVersion !== message.modelVersion) {
      loadModel(message.modelPath);
      modelVersion = message.modelVersion;
      // 缓存键是状态向量 hash，不随权重变；但权重变了，相同状态的 (P, V) 变了 → 旧缓存无效
      if (mctsEvaluator) mctsEvaluator.reset();
    }
    if (nativeSearch) nativeSearch.setModelPath(message.modelPath);
    const rng = mulberry32(workerData.config.seed ^ (message.gameIndex * 2246822519));
    const evaluator = workerData.config.mctsEvaluator === 'gpu' ? getMctsEvaluator() : null;
    const nativeEvaluator = (workerData.config.mctsEngine === 'cpp' || workerData.config.backend === 'native') ? getNativeSearch() : null;
    workerData.config.modelVersion = message.modelVersion;
    const result = await runSelfPlayGame(model, workerData.config, message.gameIndex, rng, () => stopping, evaluator, nativeEvaluator);
    // 慢局（>10s）才往上推一条，避免淹没日志
    if (result && result.durationMs > 10000) {
      parentPort.postMessage({ type: 'log',
        text: '[worker] 游戏 #' + message.gameIndex + ' 慢局 ' + (result.durationMs / 1000).toFixed(1) + 's · ' +
          result.steps + ' 步 · rounds=' + result.rounds });
    }
    parentPort.postMessage({ type: 'result', taskId: message.taskId, gameIndex: message.gameIndex, result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', taskId: message.taskId, error: error.message, stack: error.stack });
  }
});

process.on('exit', () => { if (nativeSearch) nativeSearch.close(); });
