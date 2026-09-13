'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

class SelfPlayPool {
  constructor({ root, config, size }) {
    this.root = root;
    this.config = config;
    this.size = size;
    this.workers = [];
    this.stopping = false;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(path.join(root, 'training', 'selfplay-worker.js'), {
        workerData: { config, workerId: i + 1 }
      });
      this.workers.push(worker);
    }
  }

  run(gameIndices, modelPath, modelVersion) {
    this.stopping = false;
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
    this.workers.forEach(worker => worker.postMessage({ type: 'stop' }));
  }

  async close() { await Promise.all(this.workers.map(worker => worker.terminate())); }
}

module.exports = { SelfPlayPool };
