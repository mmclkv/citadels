'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

class SelfPlayPool {
  constructor({ root, config, size, onLog = () => {}, batchForward = null,
    // 可注入，测试用假 Worker 验证「先 shutdown 再 terminate」的关闭顺序
    WorkerImpl = Worker, workerFile = null }) {
    this.root = root;
    this.config = config;
    this.size = size;
    this.onLog = onLog;
    this.batchForward = batchForward;
    this.workers = [];
    this.stopping = false;
    const script = workerFile || path.join(root, 'training', 'selfplay-worker.js');
    for (let i = 0; i < size; i++) {
      const worker = new WorkerImpl(script, {
        workerData: { config, workerId: i + 1 }
      });
      worker.on('error', error => this.onLog('[worker #' + (i + 1) + '] ' + (error.message || String(error))));
      worker.on('exit', code => {
        if (code !== 0 && !this.stopping) this.onLog('[worker #' + (i + 1) + '] 异常退出 code=' + code);
      });
      this.workers.push(worker);
    }
    this.onLog('自对弈池：已起 ' + size + ' 个 worker（PID 范围 ' +
      this.workers[0].threadId + '~' + this.workers[this.workers.length - 1].threadId + '）');
  }

  run(gameIndices, modelPath, modelVersion) {
    this.stopping = false;
    const self = this;
    return new Promise((resolve, reject) => {
      const queue = gameIndices.slice();
      const results = [];
      let active = 0, settled = false, taskId = 0;
      const cleanup = () => this.workers.forEach(worker => {
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
      });
      const finish = () => {
        if (!settled && active === 0 && (!queue.length || this.stopping)) {
          settled = true; cleanup(); resolve(results.sort((a, b) => a.gameIndex - b.gameIndex));
        }
      };
      const dispatch = worker => {
        if (this.stopping || !queue.length) return finish();
        const gameIndex = queue.shift();
        active++;
        worker.postMessage({ type: 'run', taskId: ++taskId, gameIndex, modelPath, modelVersion });
      };
      const onMessage = function(message) {
        if (message.type === 'log') { self.onLog(message.text); return; }
        // MCTS GPU 评估：worker 把一批 (state, actions) 通过 IPC 发回来，
        // 主进程统一代理给 torch.batchForward，然后把结果回写到对应 worker。
        if (message.type === 'forwardBatch') {
          const payload = message.payload || {};
          const replyWith = body => this.postMessage(Object.assign({ type: 'forwardBatchResult', id: payload.id }, body));
          if (typeof self.batchForward !== 'function') {
            replyWith({ error: 'GPU 评估器未配置（mctsEvaluator !== "gpu" 或 PyTorch 桥不可用）' });
            return;
          }
          Promise.resolve()
            .then(() => self.batchForward(payload.stateVectors || [], payload.actionVectorsList || []))
            .then(result => replyWith({ result }))
            .catch(error => replyWith({ error: (error && error.message) || String(error) }));
          return;
        }
        if (message.type === 'error') return onError(new Error(message.error + '\n' + (message.stack || '')));
        if (message.type !== 'result') return;
        active--;
        if (message.result && !message.result.stopped) results.push({ gameIndex: message.gameIndex, ...message.result });
        dispatch(this);
        finish();
      };
      const onError = error => {
        if (settled) return;
        settled = true; cleanup(); reject(error);
      };
      this.workers.forEach(worker => {
        worker.on('message', onMessage);
        worker.on('error', onError);
        dispatch(worker);
      });
    });
  }

  stop() {
    this.stopping = true;
    this.onLog('自对弈池：收到停止信号，正在通知 ' + this.workers.length + ' 个 worker');
    this.workers.forEach(worker => worker.postMessage({ type: 'stop' }));
  }

  async close() {
    this.onLog('自对弈池：关闭 ' + this.workers.length + ' 个 worker');
    // 标记为主动关闭：terminate() 的正常退出码就是 1，不置位的话 exit 处理器
    // 会把每次正常关闭都报成「异常退出 code=1」（2026-09-17 训练日志实录）。
    this.stopping = true;
    // 先通知每个 worker 自己收摊（关掉 native 搜索子进程及其拉起的 Python），
    // 等它们回 'closed' 再 terminate。terminate() 是硬杀线程，worker 内的清理代码
    // 一行都不会跑 —— 少了这一步，每次训练结束都会留下一批 mcts_worker.exe 孤儿，
    // 内存与（GPU 后端的）显存都跟着一次次累积。
    await Promise.all(this.workers.map(worker => new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        worker.removeListener('message', onClosed);
        resolve();
      };
      const onClosed = message => { if (message && message.type === 'closed') finish(); };
      worker.on('message', onClosed);
      try { worker.postMessage({ type: 'shutdown' }); }
      catch (_) { finish(); return; }
      timer = setTimeout(finish, 3000);   // worker 卡住时不无限等
    })));
    await Promise.all(this.workers.map(worker => worker.terminate()));
  }
}

module.exports = { SelfPlayPool };
