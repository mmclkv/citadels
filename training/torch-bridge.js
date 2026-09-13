'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { spawn } = require('child_process');

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
        device: this.config.backend === 'cpu' ? 'cpu' : 'cuda', modelPath: this.modelPath, optimizerPath
      });
      return this.info;
    } catch (error) {
      if (this.child) this.child.kill();
      try { fs.unlinkSync(this.modelPath); } catch (_) { /* ignored */ }
      throw error;
    }
  }

  async train(transitions) {
    const rolloutPath = path.join(this.dataDir, 'rollout-' + process.pid + '.json.gz');
    const serializable = transitions.map(row => ({
      state: Array.from(row.state), actions: row.actions.map(action => Array.from(action)), chosen: row.chosen,
      oldProb: row.oldProb, oldValue: row.oldValue, reward: row.reward, temperature: row.temperature || 1
    }));
    fs.writeFileSync(rolloutPath, zlib.gzipSync(JSON.stringify(serializable), { level: 1 }));
    try {
      const response = await this.request({ cmd: 'train', rolloutPath, modelPath: this.modelPath,
        epochs: this.config.ppoEpochs, miniBatch: this.config.miniBatch });
      this.readModel();
      return response.metrics;
    } finally {
      try { fs.unlinkSync(rolloutPath); } catch (_) { /* ignored */ }
    }
  }

  async checkpoint(checkpointName) {
    if (!this.child || !checkpointName) return;
    const optimizerPath = path.join(this.dataDir, checkpointName.replace(/\.json\.gz$/, '.optimizer.pt'));
    await this.request({ cmd: 'checkpoint', optimizerPath });
  }

  async close() {
    if (this.child) {
      try { await this.request({ cmd: 'close' }); } catch (_) { /* process may already be gone */ }
    }
    try { fs.unlinkSync(this.modelPath); } catch (_) { /* ignored */ }
  }
}

module.exports = { TorchBridge };
