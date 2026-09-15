'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { encodeSearchRequest, decodeSearchResponse } = require('../native/protocol.js');

class NativeSearchClient {
  constructor({ root, executable, simulations = 50, maxDepth = 200, batchSize = 32, cPuct = 1, seed = 1,
    gpuEvaluator = false, python = '', script = '', profile = 'balanced', device = 'cuda',
    inferenceBackend = 'python-binary' }) {
    const binary = executable || process.env.CITADELS_NATIVE_SEARCH_WORKER;
    if (!binary) throw new Error('backend:native 需要 CITADELS_NATIVE_SEARCH_WORKER 指向已编译的 mcts_worker');
    const environment = { ...process.env };
    if (inferenceBackend === 'libtorch') {
      const torchLib = path.join(root, '.python', 'Lib', 'site-packages', 'torch', 'lib');
      environment.PATH = torchLib + path.delimiter + (environment.PATH || '');
    }
    this.child = spawn(binary, [], { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
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
    this.modelPath = '';
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.#onData(chunk));
    this.child.on('error', error => this.#fail(error));
    this.child.on('exit', code => {
      if (!this.closed && code !== 0) this.#fail(new Error('native search worker 异常退出 code=' + code));
    });
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
        else waiter.resolve(decodeSearchResponse(result));
      } catch (error) { this.#fail(error); }
    }
  }

  #fail(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  search(state, rootPlayerId, legalActions, modelVersion = 0) {
    if (this.closed) return Promise.reject(new Error('native search worker 已关闭'));
    const id = String(this.nextId++);
    const request = JSON.parse(encodeSearchRequest(state, rootPlayerId, legalActions, id));
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
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(request) + '\n', error => { if (error) reject(error); });
    });
  }

  setModelPath(modelPath) { this.modelPath = modelPath || ''; }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#fail(new Error('native search worker 已关闭'));
    this.child.kill();
  }
}

module.exports = { NativeSearchClient };
