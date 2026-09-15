'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

/**
 * Owns the single Python/PyTorch process that consumes the native shared
 * memory inference queue. Native MCTS workers only open the named mapping;
 * they never create a Python or GPU context themselves.
 */
class SharedInferenceDaemon {
  constructor({ root, modelPath, profile = 'balanced', device = 'cuda', slots = 8,
    slotBytes = 8 * 1024 * 1024, onLog = () => {} }) {
    this.root = root;
    this.modelPath = modelPath;
    this.profile = profile;
    this.device = device;
    this.slots = slots;
    this.slotBytes = slotBytes;
    this.onLog = onLog;
    this.python = path.join(root, '.python', 'python.exe');
    this.script = path.join(root, 'training', 'shared_inference_daemon.py');
    this.name = `citadels_inference_${process.pid}_${Date.now()}`;
    this.child = null;
    this.ready = null;
    this.closed = false;
  }

  async start() {
    if (this.child) return this.info();
    if (!require('node:fs').existsSync(this.python)) {
      throw new Error('未找到项目私有 Python，无法启动共享 GPU 推理进程');
    }
    this.onLog('共享 GPU 推理：启动单实例 daemon（共享内存名=' + this.name + '）');
    this.child = spawn(this.python, ['-u', this.script,
      '--name', this.name,
      '--profile', this.profile,
      '--device', this.device,
      '--model', this.modelPath,
      '--slots', String(this.slots),
      '--slot-bytes', String(this.slotBytes)], {
      cwd: this.root,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', data => this.onLog('共享 GPU 推理 stderr: ' + String(data).trim()));
    this.child.on('error', error => {
      if (this.ready) this.ready.reject(error);
      this.ready = null;
      this.onLog('共享 GPU 推理进程错误：' + error.message);
    });
    this.child.on('exit', (code, signal) => {
      if (this.ready) this.ready.reject(new Error('共享 GPU 推理进程退出 code=' + code + ' signal=' + signal));
      this.ready = null;
      if (!this.closed) this.onLog('共享 GPU 推理进程异常退出：code=' + code);
      this.child = null;
    });
    this.ready = {};
    const readyPromise = new Promise((resolve, reject) => { this.ready.resolve = resolve; this.ready.reject = reject; });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', line => {
      const text = String(line).trim();
      if (text === 'READY') {
        this.onLog('共享 GPU 推理：daemon 已就绪（单进程、共享内存队列）');
        if (this.ready) this.ready.resolve();
      } else if (text) {
        this.onLog('共享 GPU 推理：' + text);
      }
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('共享 GPU 推理进程启动超时')), 30000));
    try {
      await Promise.race([readyPromise, timeout]);
      return this.info();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  info() {
    return { name: this.name, slots: this.slots, slotBytes: this.slotBytes, pid: this.child && this.child.pid };
  }

  close() {
    this.closed = true;
    if (!this.child) return Promise.resolve();
    const child = this.child;
    this.child = null;
    child.kill();
    return new Promise(resolve => child.once('close', resolve));
  }
}

module.exports = { SharedInferenceDaemon };
