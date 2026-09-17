'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, spawn, spawnSync } = require('child_process');
const { sanitizeConfig } = require('../training/train.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');

function createTrainingManager({ root = path.join(__dirname, '..'), forkImpl = fork } = {}) {
  const dataDir = path.join(root, 'training-data');
  const logsDir = path.join(dataDir, 'logs');
  const workerFile = path.join(root, 'training', 'train.js');
  let child = null;
  let preparing = false;
  let forceTimer = null;
  let activeLogFile = '';
  let logSeq = 0;
  let status = {
    state: 'idle', running: false, stopping: false, preparing: false, prepareMessage: '', completedGames: 0, targetGames: 0,
    startedAt: null, endedAt: null, point: null, history: [], checkpoint: '', error: '', logs: [], logFile: '',
    hardware: { cpu: os.cpus()[0] && os.cpus()[0].model, logicalCores: os.cpus().length,
      memoryGB: +(os.totalmem() / 2 ** 30).toFixed(1), runtime: process.version }
  };

  function appendLog(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const at = new Date().toISOString();
      // seq 单调递增（跨 restart 也不回退），前端据此只追加没渲染过的新行，
      // 避免每秒整框重建把用户的滚动位置冲掉。
      status.logs.push({ seq: ++logSeq, at, text: line.slice(0, 800) });
      if (activeLogFile) {
        try { fs.appendFileSync(activeLogFile, '[' + at + '] ' + line + os.EOL, 'utf8'); } catch (_) { /* UI 日志仍可用 */ }
      }
    }
    if (status.logs.length > 80) status.logs.splice(0, status.logs.length - 80);
  }

  function checkpoints() {
    try {
      return fs.readdirSync(dataDir)
        .filter(name => /^checkpoint-[\w-]+\.json\.gz$/.test(name))
        .sort().reverse().slice(0, 40)
        .map(name => {
          const stat = fs.statSync(path.join(dataDir, name));
          return { name, bytes: stat.size, mtimeMs: stat.mtimeMs };
        });
    } catch (_) { return []; }
  }

  function snapshot() {
    const storedCheckpoints = checkpoints();
    const storedNames = new Set(storedCheckpoints.map(item => item.name));
    const checkpointWasDeleted = !!status.checkpoint && !storedNames.has(status.checkpoint);
    if (checkpointWasDeleted) status.checkpoint = '';
    if (!child && !storedCheckpoints.length && checkpointWasDeleted) {
      status = { ...status, state: 'idle', running: false, stopping: false,
        completedGames: 0, targetGames: 0, startedAt: null, endedAt: null,
        config: undefined, point: null, history: [], checkpoint: '', error: '', logs: [], logFile: '' };
    }
    return { ...status, checkpoints: storedCheckpoints, pid: child && child.pid || null, preparing };
  }

  // 不同神经网络后端编译出的 worker 不能直接复用：python-binary 版本没有
  // 链接 LibTorch，拿它去跑 libtorch 请求会直接报「未编译 LibTorch 后端」。
  // 因此每个后端各占一份编译产物，互不覆盖。
  function nativeWorkerBackend(config) {
    return config.neuralNetworkFramework === 'libtorch' || config.nativeInferenceBackend === 'libtorch'
      ? 'libtorch' : 'python-binary';
  }

  function nativeWorkerPath(backend = 'python-binary') {
    const suffix = backend === 'libtorch' ? '_libtorch' : '';
    const name = 'mcts_worker' + suffix + (process.platform === 'win32' ? '.exe' : '');
    return path.join(root, 'native', name);
  }

  // 只看会被 mcts_worker.cpp 真正编进去的源文件，probe/bench 不参与。
  function newestNativeSourceMtime() {
    const dir = path.join(root, 'native');
    let newest = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(cpp|cc|hpp|h)$/i.test(name)) continue;
        if (/(_probe|_bench|replay_verify)\.(cpp|cc)$/i.test(name)) continue;
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
      }
    } catch (_) { return 0; }
    return newest;
  }

  function findClangCompiler() {
    const requested = process.env.CXX;
    const candidates = [
      requested,
      process.env.LLVM_ROOT && path.join(process.env.LLVM_ROOT, 'bin', process.platform === 'win32' ? 'clang++.exe' : 'clang++'),
      process.platform === 'win32' && process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'LLVM', 'bin', 'clang++.exe'),
      process.platform === 'win32' && process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'LLVM', 'bin', 'clang++.exe'),
      'clang++'
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate !== 'clang++' && fs.existsSync(candidate)) return candidate;
      if (candidate === 'clang++') {
        const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['clang++'], { encoding: 'utf8', windowsHide: true });
        const found = String(lookup.stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
        if (found) return found;
      }
    }
    return '';
  }

  function compileNativeWorker(config, outputFile, backend = 'python-binary') {
    const compilerPath = findClangCompiler();
    if (!compilerPath) throw new Error('找不到 clang++：请确认 LLVM 已安装，或设置 CXX/LLVM_ROOT 后重启服务');
    // 先落到 .tmp 再原子改名：编译失败时不要把半个 exe 留在正式路径上，
    // 否则下一次会因为「产物已存在且比源码新」跳过编译而一直用到坏产物。
    const tempFile = outputFile + '.tmp';
    const args = ['-std=c++20', '-O2', '-I', path.join(root, 'native'), path.join(root, 'native', 'mcts_worker.cpp'), '-o', tempFile];
    if (backend === 'libtorch') {
      const torchRoot = process.env.CITADELS_LIBTORCH || path.join(root, '.python', 'Lib', 'site-packages', 'torch');
      const include = path.join(torchRoot, 'include');
      const apiInclude = path.join(include, 'torch', 'csrc', 'api', 'include');
      const lib = path.join(torchRoot, 'lib');
      if (!fs.existsSync(include) || !fs.existsSync(lib)) {
        throw new Error('未找到 LibTorch：请设置 CITADELS_LIBTORCH，或先安装项目 Python 环境中的 torch');
      }
      args.unshift('-DCITADELS_LIBTORCH', '-I', include, '-I', apiInclude, '-L', lib, '-ltorch', '-ltorch_cpu', '-lc10');
    }
    appendLog('开始编译 ' + path.basename(outputFile) + '：' + compilerPath + ' ' + args.join(' '));
    return new Promise((resolve, reject) => {
      const compiler = spawn(compilerPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const output = data => appendLog('编译器：' + String(data).trim());
      compiler.stdout.on('data', output); compiler.stderr.on('data', output);
      compiler.on('error', error => reject(new Error('启动 clang++ 失败：' + error.message)));
      compiler.on('exit', (code, signal) => {
        if (code !== 0) {
          try { fs.rmSync(tempFile, { force: true }); } catch (_) { /* 忽略清理失败 */ }
          return reject(new Error('编译 ' + path.basename(outputFile) + ' 失败（code=' + code + ', signal=' + (signal || 'none') + '）'));
        }
        try {
          fs.renameSync(tempFile, outputFile);
        } catch (error) {
          // 常见原因：旧的 worker 进程还占着这个 exe（Windows 不允许覆盖正在运行的镜像）
          return reject(new Error('替换 ' + path.basename(outputFile) + ' 失败：' + error.message +
            '（可能仍有旧 worker 进程占用，请先停止训练后重试）'));
        }
        resolve(outputFile);
      });
    });
  }

  async function prepareNativeWorker(config) {
    const backend = nativeWorkerBackend(config);
    const label = backend === 'libtorch' ? 'LibTorch 直连' : 'PyTorch 桥';
    const outputFile = nativeWorkerPath(backend);
    status.prepareMessage = '检查 mcts_worker 编译产物…';
    appendLog('检查 C++ 搜索进程（' + label + '）：' + outputFile);
    const builtAt = fs.existsSync(outputFile) ? fs.statSync(outputFile).mtimeMs : 0;
    const sourceAt = newestNativeSourceMtime();
    if (!builtAt) {
      status.prepareMessage = '正在编译 ' + path.basename(outputFile) + '…';
      appendLog('未找到 ' + path.basename(outputFile) + '，准备使用 clang++ 编译');
      await compileNativeWorker(config, outputFile, backend);
      appendLog(path.basename(outputFile) + ' 编译完成');
    } else if (sourceAt > builtAt) {
      status.prepareMessage = 'native/ 源码有更新，正在重新编译…';
      appendLog('检测到 native/ 源码晚于 ' + path.basename(outputFile) + ' 的编译时间，重新编译');
      await compileNativeWorker(config, outputFile, backend);
      appendLog(path.basename(outputFile) + ' 重新编译完成');
    } else {
      status.prepareMessage = '已找到 ' + path.basename(outputFile) + '，准备启动…';
      appendLog('已找到 ' + path.basename(outputFile) + '（源码未更新），跳过编译');
    }
    return outputFile;
  }

  // 杀进程要连子进程树一起杀：训练进程会拉起 PyTorch 子进程（gpu_trainer.py）、
  // 共享推理 daemon 和 C++ mcts_worker。只 kill 父进程的话，这些后代在 Windows 上
  // 不会随之退出，会继续占着内存和 CUDA 显存（下一次开训练就 OOM）。
  function killProcessTree(target) {
    if (!target || target.exitCode != null) return;
    const pid = target.pid;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      } catch (_) { /* taskkill 不可用就退回到普通 kill */ }
    }
    try { target.kill(); } catch (_) { /* 已退出 */ }
  }

  function start(rawConfig) {
    if (child || preparing) throw new Error('训练已经在运行');
    const config = sanitizeConfig(rawConfig);
    // 新加字段时兜底：sanitizeConfig 来自缓存的 train.js，老版本会剔掉未识别字段；
    // 这里从 rawConfig 把 MCTS 系列字段显式补回，避免 server 重启前看不到新配置。
    const passthrough = ['rulesEngine', 'mctsEngine', 'neuralNetworkFramework', 'device', 'nativeInferenceBackend', 'mctsSimulations', 'mctsC_puct', 'mctsDirichletAlpha', 'mctsDirichletEpsilon', 'mctsMaxDepth',
      'selfPlayMode', 'networkPlayerCount', 'heuristicDifficulty', 'curriculumStartPlayers', 'curriculumEndPlayers', 'curriculumStepGames', 'trainNetworkOnly'];
    for (const key of passthrough) {
      if (rawConfig && rawConfig[key] != null && config[key] == null) config[key] = rawConfig[key];
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    if (config.resumeCheckpoint) {
      const checkpointFile = path.join(dataDir, config.resumeCheckpoint);
      if (!/^checkpoint-[\w-]+\.json\.gz$/.test(config.resumeCheckpoint) || !fs.existsSync(checkpointFile)) {
        throw new Error('要继续的 checkpoint 不存在，请刷新页面后重新选择，或选择从头训练');
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    activeLogFile = path.join(logsDir, 'training-' + stamp + '.log');
    fs.writeFileSync(activeLogFile, '', 'utf8');
    status = { ...status, state: 'starting', running: true, stopping: false, preparing: false, prepareMessage: '',
      completedGames: 0, targetGames: config.targetGames, startedAt: new Date().toISOString(), endedAt: null,
      config, point: null, history: [], checkpoint: '', error: '', logs: [], logFile: activeLogFile };
    if (rawConfig && rawConfig.mctsSimulations != null) {
      appendLog('MCTS 配置：模拟=' + config.mctsSimulations + ' · c_puct=' + config.mctsC_puct +
        ' · α=' + config.mctsDirichletAlpha + ' · ε=' + config.mctsDirichletEpsilon +
        ' · maxDepth=' + config.mctsMaxDepth +
        ' · 评估器=' + (config.mctsEvaluator || 'js') +
        (config.mctsEvaluator === 'gpu'
          ? '（batch=' + (config.mctsBatchSize || 32) + ' · wait=' + (config.mctsMaxWaitMs > 0 ? config.mctsMaxWaitMs + 'ms' : '0ms(即时)') + ' · cache=' + (config.mctsCacheSize || 65536) + '）'
          : ''));
    }
    const launch = workerPath => {
      if (workerPath) config.nativeSearchWorker = workerPath;
      const workerName = workerPath ? path.basename(workerPath) : '';
      status.prepareMessage = workerPath ? workerName + ' 已就绪，正在启动训练…' : '';
      appendLog(workerPath ? '启动 C++ 搜索进程：' + workerPath : '启动训练进程');
      child = forkImpl(workerFile, [], {
      cwd: root,
      env: { ...process.env, CITADELS_TRAIN_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
    child.stdout && child.stdout.on('data', data => appendLog(data));
    child.stderr && child.stderr.on('data', data => appendLog(data));
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'started') {
        status.state = 'running'; status.parameterCount = message.parameterCount;
        status.completedGames = message.completedGames || 0; status.hardware = message.hardware || status.hardware;
      } else if (message.type === 'progress') {
        status.state = status.stopping ? 'stopping' : 'running';
        status.point = message.point; status.history = message.history || status.history;
        status.completedGames = message.point && message.point.game || status.completedGames;
        if (message.checkpoint) status.checkpoint = message.checkpoint;
      } else if (message.type === 'completed' || message.type === 'stopped') {
        status.state = message.type; status.running = false; status.stopping = false;
        status.completedGames = message.completedGames; status.checkpoint = message.checkpoint || status.checkpoint;
        status.endedAt = new Date().toISOString();
      } else if (message.type === 'error') {
        status.state = 'error'; status.running = false; status.stopping = false;
        status.error = message.message || '训练进程异常'; appendLog(message.stack || message.message);
      } else if (message.type === 'log') {
        appendLog(message.text);
      }
    });
    child.on('error', error => {
      status.state = 'error'; status.running = false; status.stopping = false; status.error = error.message;
      appendLog(error.stack || error.message); child = null;
    });
    child.on('exit', (code, signal) => {
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }
      status.stopping = false;
      if (status.running) {
        status.running = false; status.endedAt = new Date().toISOString();
        if (status.state !== 'completed' && status.state !== 'stopped') {
          status.state = code === 0 ? 'stopped' : 'error';
          if (code !== 0) status.error = '训练进程退出（code=' + code + ', signal=' + (signal || 'none') + '）';
        }
      }
      child = null;
      activeLogFile = '';
    });
    };
    const needsNative = config.mctsSimulations > 0 &&
      (config.mctsEngine === 'cpp' || config.backend === 'native');
    if (needsNative) {
      preparing = true;
      prepareNativeWorker(config).then(workerPath => {
        preparing = false;
        if (!status.stopping && status.running) launch(workerPath);
        else { status.state = 'stopped'; status.running = false; status.endedAt = new Date().toISOString(); }
      }).catch(error => {
        preparing = false; status.state = status.stopping ? 'stopped' : 'error'; status.running = false; status.endedAt = new Date().toISOString(); status.error = status.stopping ? '' : error.message;
        appendLog(error.stack || error.message); activeLogFile = '';
      });
    } else launch('');
    return snapshot();
  }

  function stop() {
    if (preparing && status.running) {
      status.stopping = true; status.state = 'stopping'; status.prepareMessage = '正在停止 mcts_worker 准备流程…';
      appendLog('收到停止请求，取消 mcts_worker 准备流程');
      return snapshot();
    }
    if (!child || !status.running) return snapshot();
    status.stopping = true; status.state = 'stopping';
    try { child.send({ type: 'stop' }); } catch (_) { /* exit handler will settle */ }
    forceTimer = setTimeout(() => {
      if (child) { appendLog('优雅停止超时，终止训练进程及其子进程（Python / mcts_worker）'); killProcessTree(child); }
    }, 15000);
    forceTimer.unref();
    return snapshot();
  }

  function profileInfo(profile) {
    const model = new PolicyValueNetwork({ profile });
    return model.parameterCount;
  }

  return { start, stop, status: snapshot, checkpoints, profileInfo };
}

module.exports = { createTrainingManager };
