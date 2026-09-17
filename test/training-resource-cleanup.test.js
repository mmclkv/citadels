'use strict';

/**
 * 训练资源回收回归测试。
 *
 * 目的是锁住两类「跑久了内存/显存一路涨」的坑：
 *  1. NativeSearchClient 建了 stderr 管道就必须有人读 —— 不读的话数据无上限堆在
 *     流的内部缓冲里，而且管道写满后子进程会卡死在写 stderr 上（实测 4MB 即阻塞）。
 *  2. SelfPlayPool.close() 必须先让 worker 自己关掉 native 搜索子进程再 terminate。
 *     terminate() 是硬杀线程，worker 内的清理代码一行都不会跑，直接 terminate 会把
 *     mcts_worker.exe（以及它拉起的 gpu_trainer.py）留成孤儿进程，每次训练累积一批。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const { SelfPlayPool } = require(path.join(ROOT, 'training', 'selfplay-pool.js'));
const { NativeSearchClient } = require(path.join(ROOT, 'training', 'native-search.js'));

function workerBinary() {
  const fromEnv = process.env.CITADELS_NATIVE_SEARCH_WORKER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const built = path.join(ROOT, 'native', 'mcts_worker.exe');
  return fs.existsSync(built) ? built : '';
}

class FakeWorker extends EventEmitter {
  constructor(script, options) {
    super();
    this.script = script;
    this.options = options;
    this.threadId = FakeWorker.nextId++;
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.posted.push(message);
    // 真 worker 收到 shutdown 会关掉 native 子进程后回一条 closed
    if (message && message.type === 'shutdown') {
      setImmediate(() => this.emit('message', { type: 'closed' }));
    }
  }

  async terminate() {
    this.terminated = true;
    FakeWorker.order.push(['terminate', this.threadId]);
  }
}
FakeWorker.nextId = 1;
FakeWorker.instances = [];
FakeWorker.order = [];

async function poolClosesGracefully() {
  FakeWorker.instances = [];
  FakeWorker.order = [];
  const pool = new SelfPlayPool({
    root: ROOT, config: { mctsSimulations: 0 }, size: 3,
    onLog: () => {}, WorkerImpl: FakeWorker,
    workerFile: path.join(ROOT, 'training', 'selfplay-worker.js')
  });
  await pool.close();
  const workers = FakeWorker.instances;
  assert.strictEqual(workers.length, 3, '池应该起了 3 个 worker');
  for (const worker of workers) {
    const shutdown = worker.posted.find(m => m && m.type === 'shutdown');
    assert.ok(shutdown, 'close() 前必须给 worker 发 shutdown，否则 native 子进程会变孤儿');
    assert.ok(worker.terminated, 'close() 最终必须 terminate worker');
  }
  console.log('自对弈池关闭：先 shutdown 再 terminate（3/3 worker）');
}

async function nativeStderrIsDrained() {
  const binary = workerBinary();
  if (!binary) {
    console.log('native worker 未编译，跳过 stderr 回收用例');
    return;
  }
  const client = new NativeSearchClient({
    root: ROOT, executable: binary, simulations: 8, maxDepth: 20, batchSize: 8, cPuct: 1, seed: 7
  });
  try {
    assert.ok(client.child.stderr, '子进程应该带 stderr 管道');
    assert.ok(client.child.stderr.listenerCount('data') > 0,
      'stderr 必须挂 data 监听：不读会无上限堆积并最终把子进程卡死在写 stderr 上');
    assert.strictEqual(typeof client.lastStderr(), 'string', 'lastStderr() 应返回字符串');
  } finally {
    client.close();
  }
  console.log('native 搜索客户端：stderr 已接管且有上限（lastStderr 保留最后 4KB）');
}

function managerKillsWholeTree() {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'training-manager.js'), 'utf8');
  assert.ok(/taskkill[\s\S]{0,80}\/T/.test(source),
    '强杀训练进程时必须连子进程树一起杀（taskkill /T），否则 Python / mcts_worker 会残留并占住显存');
  assert.ok(/killProcessTree\(child\)/.test(source), '停止超时路径应调用 killProcessTree');
  console.log('训练管理器：强杀走进程树清理（taskkill /T /F）');
}

(async () => {
  await poolClosesGracefully();
  await nativeStderrIsDrained();
  managerKillsWholeTree();
  console.log('训练资源回收：3 组断言通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
