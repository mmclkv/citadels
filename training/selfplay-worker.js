'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { PolicyValueNetwork, mulberry32 } = require('./neural-policy.js');
const { runSelfPlayGame } = require('./train.js');

const model = new PolicyValueNetwork({ profile: workerData.config.profile,
  stateSize: 192, actionSize: 64, seed: workerData.config.seed ^ (workerData.workerId * 2654435761) });
let modelVersion = -1;
let stopping = false;

function loadModel(filename) {
  const data = fs.readFileSync(filename);
  const flat = new Float32Array(data.byteLength / 4);
  for (let i = 0; i < flat.length; i++) flat[i] = data.readFloatLE(i * 4);
  model.importFlat(flat);
}

parentPort.on('message', async message => {
  if (message.type === 'stop') { stopping = true; return; }
  if (message.type !== 'run') return;
  stopping = false;
  try {
    if (modelVersion !== message.modelVersion) {
      loadModel(message.modelPath);
      modelVersion = message.modelVersion;
    }
    const rng = mulberry32(workerData.config.seed ^ (message.gameIndex * 2246822519));
    const result = await runSelfPlayGame(model, workerData.config, message.gameIndex, rng, () => stopping);
    parentPort.postMessage({ type: 'result', taskId: message.taskId, gameIndex: message.gameIndex, result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', taskId: message.taskId, error: error.message, stack: error.stack });
  }
});
