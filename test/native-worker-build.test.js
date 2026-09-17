'use strict';

// 回归：不同神经网络后端需要各自的 mcts_worker 编译产物。
// 历史上 prepareNativeWorker 只看盘上有没有 mcts_worker.exe，于是选了 LibTorch
// 也会直接复用没链接 torch 的旧二进制，跑到线上才报「未编译 LibTorch 后端」。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createTrainingManager } = require('../lib/training-manager.js');

const exeName = name => name + (process.platform === 'win32' ? '.exe' : '');
const future = Date.now() + 24 * 3600 * 1000;

// Windows 上新编译出的 exe 可能短暂被占用（杀软/文件系统延迟），清理重试几次。
function remove(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return; } catch (_) {}
  }
}

function makeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-native-worker-'));
  fs.mkdirSync(path.join(root, 'training-data'), { recursive: true });
  const nativeDir = path.join(root, 'native');
  fs.mkdirSync(nativeDir, { recursive: true });
  // 最小可编译源，避免真的把整套 native 头文件拉进来
  fs.writeFileSync(path.join(nativeDir, 'mcts_worker.cpp'), 'int main() { return 0; }\n');
  for (const name of files || []) {
    const file = path.join(nativeDir, exeName(name));
    fs.writeFileSync(file, 'stub');
    fs.utimesSync(file, future / 1000, future / 1000);
  }
  return root;
}

// 走到微任务队列之后再看日志：prepareNativeWorker 是 async，start() 不等待它。
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

function startWith(root, config) {
  let launchedConfig = null;
  const seen = [];
  const child = { pid: 1, on() {}, stdout: null, stderr: null, send() {}, kill() {} };
  const manager = createTrainingManager({ root, forkImpl: (file, args, options) => {
    launchedConfig = JSON.parse(options.env.CITADELS_TRAIN_CONFIG);
    return child;
  } });
  manager.start(config);
  return { manager, child, seen, launched: () => launchedConfig };
}

function logsOf(manager) {
  return manager.status().logs.map(line => line.text).join('\n');
}

async function main() {
  // 1) 选择 LibTorch 后端时，必须用 _libtorch 后缀的产物
  {
    const root = makeRoot(['mcts_worker', 'mcts_worker_libtorch']);
    const run = startWith(root, { targetGames: 1, minPlayers: 2, maxPlayers: 2, profile: 'fast',
      mctsSimulations: 1, mctsEngine: 'cpp', neuralNetworkFramework: 'libtorch' });
    await settle();
    const launched = run.launched();
    assert.ok(launched, 'LibTorch 配置会正常启动训练子进程');
    assert.strictEqual(launched.nativeSearchWorker, path.join(root, 'native', exeName('mcts_worker_libtorch')),
      'LibTorch 后端要使用独立的 mcts_worker_libtorch 产物');
    assert.match(logsOf(run.manager), /原生\/源码|已找到 mcts_worker_libtorch/, '日志要点名使用的是 LibTorch 产物');
    remove(root);
  }

  // 2) 默认 PyTorch 后端继续用原产物，两者互不覆盖
  {
    const root = makeRoot(['mcts_worker', 'mcts_worker_libtorch']);
    const run = startWith(root, { targetGames: 1, minPlayers: 2, maxPlayers: 2, profile: 'fast',
      mctsSimulations: 1, mctsEngine: 'cpp', neuralNetworkFramework: 'pytorch' });
    await settle();
    assert.strictEqual(run.launched().nativeSearchWorker, path.join(root, 'native', exeName('mcts_worker')),
      'PyTorch 后端使用默认 mcts_worker 产物');
    assert.ok(fs.existsSync(path.join(root, 'native', exeName('mcts_worker_libtorch'))),
      '切换后端不会覆盖另一个后端的产物');
    remove(root);
  }

  // 3) 源码比产物新时需要重新编译，不能因为「产物存在」就跳过
  {
    const compiler = process.env.CXX || (process.platform === 'win32' && process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'LLVM', 'bin', 'clang++.exe') : '');
    const hasCompiler = compiler && fs.existsSync(compiler);
    if (!hasCompiler) {
      console.log('· 跳过「源码更新需重编译」断言：未找到可用的 clang++');
    } else {
      const root = makeRoot(['mcts_worker']);
      const staleAt = new Date('2020-01-01T00:00:00Z').getTime();
      const exe = path.join(root, 'native', exeName('mcts_worker'));
      fs.utimesSync(exe, staleAt / 1000, staleAt / 1000);
      const run = startWith(root, { targetGames: 1, minPlayers: 2, maxPlayers: 2, profile: 'fast',
        mctsSimulations: 1, mctsEngine: 'cpp', neuralNetworkFramework: 'pytorch' });
      await settle();
      assert.match(logsOf(run.manager), /重新编译/, '源码比产物新时应重新编译而不是复用旧产物');
      assert.ok(fs.statSync(exe).size > 0, '重新编译后产物可用');
      assert.ok(!fs.existsSync(exe + '.tmp'), '编译完成后不残留 .tmp 中间产物');
      remove(root);
    }
  }

  console.log('native worker 编译产物选择：3 组断言通过');
}

main().catch(error => { console.error(error); process.exit(1); });
