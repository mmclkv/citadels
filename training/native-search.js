'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildSearchRequest, decodeSearchResponse } = require('../native/protocol.js');

// 显存不足（CUDA OOM）时的重启上限与冷却时间。6GB 显卡还要和桌面合成器共享
// 显存，偶发 OOM 不该中断训练；但真的持续 OOM 时也不能无限重启把机器拖垮。
const MAX_OOM_RESTARTS = 3;
const OOM_RESTART_COOLDOWN_MS = 30000;
// 单个搜索请求的等待上限：子进程卡死（死循环、驱动掉卡、被系统暂停）时这条请求
// 再也不会回来，waiter 会一直挂在 pending 里连带把调用方那一整帧钉在堆上。
// 0 = 不限制。
const DEFAULT_SEARCH_TIMEOUT_MS = 120000;

class NativeSearchClient {
  constructor({ root, executable, simulations = 50, maxDepth = 200, batchSize = 32, cPuct = 1, seed = 1,
    gpuEvaluator = false, python = '', script = '', profile = 'balanced', device = 'cuda',
    inferenceBackend = 'python-binary', sharedMemoryName = '', sharedMemorySlots = 8,
    sharedMemorySlotBytes = 8 * 1024 * 1024, searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS }) {
    const binary = executable || process.env.CITADELS_NATIVE_SEARCH_WORKER;
    if (!binary) throw new Error('backend:native 需要 CITADELS_NATIVE_SEARCH_WORKER 指向已编译的 mcts_worker');
    const environment = { ...process.env };
    if (inferenceBackend === 'libtorch') {
      const torchLib = path.join(root, '.python', 'Lib', 'site-packages', 'torch', 'lib');
      environment.PATH = torchLib + path.delimiter + (environment.PATH || '');
      // 6GB 级显卡上 batching 的高峰显存很容易碎片化到「总量够、连续块不够」而 OOM
      // （2026-09-17 训练日志：单次申请 2.80 GiB 失败）。expandable_segments 让
      // 分配器可以整体伸缩段，PyTorch 官方 OOM 提示也是这个建议。用户显式设了就不覆盖。
      if (!environment.PYTORCH_CUDA_ALLOC_CONF) {
        environment.PYTORCH_CUDA_ALLOC_CONF = 'expandable_segments:True';
      }
    }
    this.root = root;
    this.binary = binary;
    this.environment = environment;
    this.simulations = simulations;
    this.maxDepth = maxDepth;
    this.batchSize = Math.max(1, Number(batchSize) || 32);
    this.cPuct = cPuct;
    this.seed = seed;
    this.gpuEvaluator = gpuEvaluator;
    this.python = python;
    this.script = script;
    this.profile = profile;
    this.device = device;
    this.inferenceBackend = inferenceBackend === 'libtorch' ? 'libtorch' : 'python-binary';
    this.sharedMemoryName = sharedMemoryName || '';
    this.sharedMemorySlots = Math.max(1, Number(sharedMemorySlots) || 8);
    this.sharedMemorySlotBytes = Math.max(1024, Number(sharedMemorySlotBytes) || 8 * 1024 * 1024);
    this.modelPath = '';
    this.nextId = 1;
    this.pending = new Map();
    // 连续搜索失败数：跨请求累计，调用方（runSelfPlayGame）据此判断这条搜索通道
    // 是不是真的坏了，成功一次就清零。
    this.searchFailureStreak = 0;
    this.searchTimeoutMs = Math.max(0, Number(searchTimeoutMs) || 0);
    this.buffer = '';
    this.closed = false;
    // 子进程已经没了（崩溃 /段错误 / OOM 重启前）：置位后 search() 立即失败，
    // 不再往已销毁的 stdin 上写、也不再往 pending 里堆永远结算不掉的 waiter。
    this.childExited = false;
    this.lastExitError = '';
    // stderr 必须有人读：管道建了却不读，数据会无上限堆在流的内部缓冲里（内存泄漏），
    // 而且管道一旦写满，子进程会阻塞在写 stderr 上（实测 4MB 就卡死）——LibTorch /
    // torch 初始化警告、Python traceback 都往这里打，不读迟早出事。
    // 这里只保留最后一段用于报错定位，不让它无限增长。
    this.stderrTail = '';
    this.oomRestarts = 0;
    this.lastOomRestartAt = 0;
    this.#startChild();
  }

  // 起（或重启）子进程。抽出来是因为显存不足时要整个换一个进程：PyTorch 的缓存
  // 分配器只进不出，同一个进程里再怎么重试，显存块也不会回到驱动手里；换进程
  // 等于把 CUDA 上下文和缓存一起还回去，比任何「清缓存」都彻底。
  #startChild() {
    this.buffer = '';
    this.childExited = false;
    this.lastExitError = '';
    this.child = spawn(this.binary, [], { cwd: this.root, env: this.environment,
      stdio: ['pipe', 'pipe', 'pipe'] });
    const child = this.child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => this.#onStderr(chunk));
    // 旧进程是「被重启换掉的」，它之后报的错 / 非 0 退出码都与当前进程无关，
    // 不能拿去 reject 现在这批请求。
    const isCurrent = () => child === this.child;
    child.on('error', error => { if (isCurrent()) this.#fail(error); });
    child.on('exit', code => {
      if (!isCurrent() || code === 0) return;
      // 子进程没了：后续请求绝不可能完成。以前这里只 reject 当时在飞的那几个，
      // 没有留下「通道已死」的痕迹，于是每步照写 stdin → 拿一条
      // ERR_STREAM_DESTROYED → 把 waiter 留在 pending 里再也删不掉，而 waiter
      // 抓着的正是调用方整个 async 帧（一局几百条训练样本）。自对弈 worker 就是
      // 这么被吃到 heap OOM 的（2026-09-19 训练日志：2128 局 native worker
      // 段错误退出，2187 局 worker JS heap 爆掉，一小时的样本全丢）。
      this.childExited = true;
      const tail = this.lastStderr();
      this.lastExitError = 'native mcts_worker 异常退出 code=' + code +
        (tail ? ' · stderr: ' + tail : '');
      if (!this.closed) this.#fail(new Error(this.lastExitError));
    });
  }

  // 显存不足时重启子进程并重试。次数和频率都设了上限：真的一直 OOM 就别无限
  // 重启把机器拖垮，把错误交回上层（那边会退化成本步不搜索）。
  #retryAfterOom(error, retry) {
    const message = (error && error.message) || String(error);
    if (this.closed || !/out of memory/i.test(message)) return Promise.reject(error);
    if (this.oomRestarts >= MAX_OOM_RESTARTS) return Promise.reject(error);
    const now = Date.now();
    if (now - this.lastOomRestartAt < OOM_RESTART_COOLDOWN_MS) return Promise.reject(error);
    this.oomRestarts++;
    this.lastOomRestartAt = now;
    this.restart();
    return retry();
  }

  restart() {
    const previous = this.child;
    this.#fail(new Error('native mcts_worker 因显存不足重启'));
    try { this.#killTree(previous); } catch (_) { /* 进程可能已退出 */ }
    this.#startChild();
  }

  #killTree(child) {
    if (!child || child.exitCode != null) return;
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        return;
      } catch (_) { /* taskkill 不可用，走下面的普通 kill */ }
    }
    child.kill();
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const result = JSON.parse(line);
        const waiter = this.pending.get(String(result.id));
        if (!waiter) continue;
        this.pending.delete(String(result.id));
        if (result.t === 'error') waiter.reject(new Error(result.error || 'native 搜索失败'));
        else { this.searchFailureStreak = 0; waiter.resolve(decodeSearchResponse(result)); }
      } catch (error) { this.#fail(error); }
    }
    // 兜底：子进程吐了大量没有换行的输出时（异常日志风暴），别让 buffer 无限膨胀。
    if (this.buffer.length > 16 * 1024 * 1024) this.buffer = '';
  }

  #onStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk).slice(-4096);
  }

  lastStderr() { return this.stderrTail.trim(); }

  #fail(error) {
    // 这些请求都没机会完成了，算进失败 streak 让上层有机会熔断
    this.searchFailureStreak += this.pending.size;
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /**
   * @param {object|object[]} state 根局面，或「粒子池」（对未知手牌的若干份猜测）。
   *   传数组时整池进同一棵搜索树，每条模拟抽一份 —— 与 JS 侧 mcts.search 的
   *   rootStates 语义一致。传单个局面即退化为改造前的单世界搜索。
   */
  search(state, rootPlayerId, legalActions, modelVersion = 0, particleWeights = null) {
    if (this.closed) return Promise.reject(new Error('native mcts_worker 已关闭'));
    // 子进程已经退出：直接失败，别再往销毁的 stdin 上写，也别再往 pending 里堆。
    // 失败同样计入 streak —— 上层靠它判断「这条通道是不是彻底坏了」，这里漏计
    // 就会让熔断永远不触发。
    if (this.childExited) {
      this.searchFailureStreak++;
      return Promise.reject(new Error(this.lastExitError || 'native mcts_worker 已退出'));
    }
    const id = String(this.nextId++);
    const request = buildSearchRequest(state, rootPlayerId, legalActions, id, particleWeights);
    request.simulations = this.simulations;
    request.maxDepth = this.maxDepth;
    request.batchSize = this.batchSize;
    request.cPuct = this.cPuct;
    request.seed = this.seed ^ this.nextId;
    request.gpuEvaluator = this.gpuEvaluator;
    if (this.gpuEvaluator) {
      request.python = this.python;
      request.script = this.script;
      request.profile = this.profile;
      request.device = this.device;
      request.inferenceBackend = this.inferenceBackend;
      request.modelPath = this.modelPath;
      request.modelVersion = modelVersion;
      if (this.sharedMemoryName && this.inferenceBackend !== 'libtorch') {
        request.sharedMemoryName = this.sharedMemoryName;
        request.sharedMemorySlots = this.sharedMemorySlots;
        request.sharedMemorySlotBytes = this.sharedMemorySlotBytes;
      }
    }
    return new Promise((resolve, reject) => {
      // waiter 自己也持有「怎么删掉我」的知识：任何一条出口（回包 / 报错 / 超时
      // / 批量 fail）都必须把条目从 pending 里摘掉。留在 Map 里的 waiter 会一直
      // 抓着调用方这一帧不放 —— pending 无界增长就是那次 worker heap OOM 的全部来源。
      // timer 必须在 waiter 自己手里清，不能靠 #settle 查 pending：#onData 成功路径
      // 会先把条目从 pending 摘掉再调 resolve，那时 #settle 已经查不到 waiter，
      // clearTimeout 就永远不会执行 —— 每个成功请求都漏一个 timer，闭包里钉着
      // 整份请求（含 4 份粒子 state）；timer 到点还会照常 fire 去重启子进程，
      // 把当下健康的请求全部误杀（2026-09-20 探针实测：纯 JS 链路 37% 请求
      // 被「因显存不足重启」误伤，heap 随超时窗口锯齿漂移）。
      const waiter = {
        resolve: value => { this.#settle(id); resolve(value); },
        reject: error => { this.#settle(id); reject(error); },
        timer: null
      };
      waiter.settle = () => {
        this.#settle(id);
        if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
      };
      waiter.resolve = value => { waiter.settle(); resolve(value); };
      waiter.reject = error => { waiter.settle(); reject(error); };
      this.pending.set(id, waiter);
      if (this.searchTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.searchFailureStreak++;
          waiter.reject(new Error('native 搜索超时 ' + this.searchTimeoutMs + 'ms'));
          // 子进程多半已经卡死（死循环 / 掉卡 / 被系统暂停）：整个换掉，既回收它
          // 占的资源，也让后面的请求能落到健康的进程上。
          this.restart();
        }, this.searchTimeoutMs);
      }
      this.child.stdin.write(JSON.stringify(request) + '\n',
        error => { if (error) waiter.reject(error); });
    }).catch(error => this.#retryAfterOom(error,
      () => this.search(state, rootPlayerId, legalActions, modelVersion, particleWeights)));
  }

  // 从 pending 里摘掉一条已经结算的请求（含它的超时定时器）。用 identity 比对，
  // 免得把同 id 的后来者误删。
  #settle(id) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (waiter.timer) clearTimeout(waiter.timer);
  }

  setModelPath(modelPath) { this.modelPath = modelPath || ''; }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#fail(new Error('native mcts_worker 已关闭'));
    // Windows 上 kill() 只杀这一个进程；万一 native worker 以后再拉子进程，
    // 留下的就是占着显存的孤儿（2026-09-17 日志：池关闭 30 秒后孤儿还在跑并 OOM）。
    // taskkill /T 连整棵树一起杀，失败再回退普通 kill。
    if (process.platform === 'win32' && this.child.pid && this.child.exitCode == null) {
      try {
        spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' });
        return;
      } catch (_) { /* taskkill 不可用，走下面的普通 kill */ }
    }
    this.child.kill();
  }
}

module.exports = { NativeSearchClient };
