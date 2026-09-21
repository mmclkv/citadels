'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { writeRollout } = require('./rollout-format.js');

class TorchBridge {
  constructor({ root, model, config, onLog = () => {} }) {
    this.root = root;
    this.model = model;
    this.config = config;
    this.onLog = onLog;
    this.dataDir = path.join(root, 'training-data');
    this.modelPath = path.join(this.dataDir, 'live-model-' + process.pid + '.bin');
    this.python = path.join(root, '.python', 'python.exe');
    this.script = path.join(root, 'training', 'gpu_trainer.py');
    this.pending = [];
    this.child = null;
    this.info = null;
    // GPU 串行锁：train / batchForward / checkpoint 共享同一个 PyTorch 子进程，
    // 用这条 Promise 链保证它们互斥执行，绝不在 GPU 上并发（避免权重读写竞争与响应错位）。
    this._gpuLock = Promise.resolve();
  }

  // 把一次「独占 GPU 子进程」的操作串到锁链上：同一时刻只有一项在跑。
  // 即便调用方并发发来 train 与 batchForward，后者也会等前者彻底结束（含读回权重）后才发出。
  _withGpuLock(task) {
    const run = this._gpuLock.then(task);
    // 无论成功失败都推进锁链，避免一次异常永久卡死后续 GPU 操作
    this._gpuLock = run.then(() => {}, () => {});
    return run;
  }

  writeModel() {
    const flat = this.model.exportFlat();
    fs.writeFileSync(this.modelPath, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));
  }

  readModel() {
    const data = fs.readFileSync(this.modelPath);
    const copy = new Float32Array(data.byteLength / 4);
    for (let i = 0; i < copy.length; i++) copy[i] = data.readFloatLE(i * 4);
    this.model.importFlat(copy);
  }

  request(message) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(message) + '\n');
    });
  }

  async start(resumeCheckpoint = '') {
    if (!fs.existsSync(this.python)) throw new Error('未找到项目私有 Python，请先安装 CUDA 版 PyTorch');
    this.writeModel();
    this.child = spawn(this.python, ['-u', this.script], {
      cwd: this.root, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      const waiting = this.pending.shift();
      if (!waiting) return this.onLog('PyTorch: ' + line);
      try {
        const result = JSON.parse(line);
        if (!result.ok) waiting.reject(new Error(result.error || 'PyTorch 训练失败'));
        else waiting.resolve(result);
      } catch (error) { waiting.reject(error); }
    });
    this.child.stderr.on('data', data => this.onLog(String(data).trim()));
    this.child.on('exit', code => {
      const error = new Error('PyTorch 子进程退出（code=' + code + '）');
      while (this.pending.length) this.pending.shift().reject(error);
      this.child = null;
    });
    const optimizerPath = resumeCheckpoint
      ? path.join(this.dataDir, resumeCheckpoint.replace(/\.json\.gz$/, '.optimizer.pt')) : '';
    try {
      this.info = await this.request({
        cmd: 'init', profile: this.config.profile, learningRate: this.config.learningRate,
        device: this.config.device || (this.config.backend === 'cpu' ? 'cpu' : 'cuda'), modelPath: this.modelPath, optimizerPath
      });
      this.onLog('训练器 init 完成：profile=' + this.config.profile + ' · lr=' + this.config.learningRate +
        ' · device=' + (this.config.device || (this.config.backend === 'cpu' ? 'cpu' : 'cuda')) +
        (resumeCheckpoint ? ' · 续训 optimizer 已挂载' : ' · 全新 optimizer'));
      return this.info;
    } catch (error) {
      if (this.child) this.child.kill();
      try { fs.unlinkSync(this.modelPath); } catch (_) { /* ignored */ }
      throw error;
    }
  }

  async train(transitions) {
    return this._withGpuLock(() => this._trainCore(transitions));
  }

  async _trainCore(transitions) {
    const rolloutPath = path.join(this.dataDir, 'rollout-' + process.pid + '.bin');
    // 直写二进制：整批样本经一个 4MB 复用缓冲分块落盘，不再有
    // Array.from 副本 / JSON 巨型字符串 / gzip 缓冲这三份中间物。
    // 实测 256 局一批：旧路径序列化阶段额外驻留 2676 MB，现在只剩写入缓冲。
    const rollout = writeRollout(rolloutPath, transitions);
    try {
      const response = await this.request({ cmd: 'train', rolloutPath, rolloutFormat: 'ctrl-binary',
        rolloutBytes: rollout.bytes, modelPath: this.modelPath,
        epochs: this.config.ppoEpochs, miniBatch: this.config.miniBatch,
        policyLossMode: this.config.policyLossMode || 'auto',
        mctsCeRequired: this.config.policyLossMode === 'mcts_ce' ||
          (this.config.policyLossMode === 'auto' && Number(this.config.mctsSimulations) > 0) });
      this.readModel();
      return response.metrics;
    } finally {
      try { fs.unlinkSync(rolloutPath); } catch (_) { /* ignored */ }
    }
  }

  async checkpoint(checkpointName) {
    if (!this.child || !checkpointName) return;
    const optimizerPath = path.join(this.dataDir, checkpointName.replace(/\.json\.gz$/, '.optimizer.pt'));
    return this._withGpuLock(() => this.request({ cmd: 'checkpoint', optimizerPath }));
  }

  /**
   * 批量前向评估：把 MCTS 在 worker 里攒出来的若干 (state, [actions]) 一次送进 PyTorch。
   * 经 _withGpuLock 串行：与 train / checkpoint 互斥，绝不会在 PPO 更新权重的过程中
   * 并发插入一次批量前向（否则会用到半更新权重、或让 FIFO 响应错位）。
   */
  async batchForward({ stateVectors, actionVectorsList }) {
    if (!this.child) throw new Error('PyTorch 桥未启动，无法 batch_forward');
    return this._withGpuLock(() => this.request({
      cmd: 'batch_eval', stateVectors, actionVectorsList, profile: this.config.profile
    }));
  }

  async close() {
    if (this.child) {
      try { await this.request({ cmd: 'close' }); } catch (_) { /* process may already be gone */ }
    }
    try { fs.unlinkSync(this.modelPath); } catch (_) { /* ignored */ }
  }
}

module.exports = { TorchBridge };
