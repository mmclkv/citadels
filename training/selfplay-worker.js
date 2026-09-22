'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { PolicyValueNetwork, mulberry32 } = require('./neural-policy.js');
const { runSelfPlayGame } = require('./train.js');
const { NativeSearchClient } = require('./native-search.js');

const model = new PolicyValueNetwork({ profile: workerData.config.profile,
  stateSize: 672, actionSize: 256, encodingVersion: 7,
  seed: workerData.config.seed ^ (workerData.workerId * 2654435761) });
let modelVersion = -1;
let stopping = false;

let nativeSearch = null;

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
    gpuEvaluator: workerData.config.mctsEvaluator !== 'js',
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
  // 池关闭前先走这条路：worker.terminate() 不会执行本文件里的任何清理代码，
  // 直接 terminate 会把 mcts_worker.exe（以及它拉起的 gpu_trainer.py）留成孤儿进程，
  // 每个都占内存、GPU 后端还各占一份 CUDA 显存。所以先自己关，再让池来 terminate。
  if (message.type === 'shutdown') {
    if (nativeSearch) { try { nativeSearch.close(); } catch (_) { /* 进程可能已退出 */ } nativeSearch = null; }
    parentPort.postMessage({ type: 'closed' });
    return;
  }
  if (message.type !== 'run') return;
  stopping = false;
  try {
    if (modelVersion !== message.modelVersion) {
      loadModel(message.modelPath);
      modelVersion = message.modelVersion;
    }
    if (nativeSearch) nativeSearch.setModelPath(message.modelPath);
    const rng = mulberry32(workerData.config.seed ^ (message.gameIndex * 2246822519));
    const nativeEvaluator = workerData.config.mctsSimulations > 0 &&
      (workerData.config.mctsEngine === 'cpp' || workerData.config.backend === 'native')
      ? getNativeSearch() : null;
    workerData.config.modelVersion = message.modelVersion;
    const result = await runSelfPlayGame(model, workerData.config, message.gameIndex, rng, () => stopping, null, nativeEvaluator);
    // 跑不通（无合法行动 / 超步数）的局会被 train.js 置为 null：丢弃它并打一条日志，
    // 既不让整次训练崩掉，也不会让这类死角悄无声息地消失。
    // 超回合上限的局现在会以当前局面排名收尾，保留已经搜索出的样本；
    // 这里保留 dropped 分支兼容旧版/其它失败路径。
    if (result && result.dropped) {
      parentPort.postMessage({ type: 'log',
        text: '[worker] 游戏 #' + message.gameIndex + ' ' + result.reason +
          '，已丢弃该局（未计入数据）· ' + result.steps + ' 步 · ' +
          ((result.durationMs || 0) / 1000).toFixed(1) + 's' });
      parentPort.postMessage({ type: 'result', taskId: message.taskId, gameIndex: message.gameIndex, result: null });
      return;
    }
    if (result && result.truncated) {
      parentPort.postMessage({ type: 'log',
        text: '[worker] 游戏 #' + message.gameIndex + ' 达到回合上限，按当前排名提前结算 · ' +
          result.steps + ' 步 · rounds=' + result.rounds });
    }
    if (!result) {
      parentPort.postMessage({ type: 'log',
        text: '[worker] 游戏 #' + message.gameIndex + ' 无法跑完，已跳过该局（未计入数据）' });
    }
    // 慢局（>10s）才往上推一条，避免淹没日志
    if (result && result.durationMs > 10000) {
      parentPort.postMessage({ type: 'log',
        text: '[worker] 游戏 #' + message.gameIndex + ' 慢局 ' + (result.durationMs / 1000).toFixed(1) + 's · ' +
          result.steps + ' 步 · rounds=' + result.rounds });
    }
    // 定期报一次 worker 自己的内存。跑几万局的长训练里这是唯一的判据：heap 曲线
    // 平是稳态、斜着往上走就是泄漏（2026-09-19 那次 native worker 崩溃后，每局
    // 泄漏一整份样本，heap 一路爬到 V8 上限把 worker 打死）。
    if (message.gameIndex % 200 === 0) {
      const memory = process.memoryUsage();
      const mb = bytes => (bytes / 1024 / 1024).toFixed(0) + 'MB';
      parentPort.postMessage({ type: 'log',
        text: '[worker] 内存 · 第 ' + message.gameIndex + ' 局 · heapUsed=' + mb(memory.heapUsed) +
          ' · arrayBuffers=' + mb(memory.arrayBuffers) + ' · rss=' + mb(memory.rss) +
          (nativeSearch && nativeSearch.searchFailureStreak
            ? ' · 连续搜索失败=' + nativeSearch.searchFailureStreak : '') });
    }
    parentPort.postMessage({ type: 'result', taskId: message.taskId, gameIndex: message.gameIndex, result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', taskId: message.taskId, error: error.message, stack: error.stack });
  }
});

process.on('exit', () => { if (nativeSearch) nativeSearch.close(); });
