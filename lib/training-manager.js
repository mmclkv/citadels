'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const { sanitizeConfig } = require('../training/train.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');

function createTrainingManager({ root = path.join(__dirname, '..'), forkImpl = fork } = {}) {
  const dataDir = path.join(root, 'training-data');
  const workerFile = path.join(root, 'training', 'train.js');
  let child = null;
  let forceTimer = null;
  let status = {
    state: 'idle', running: false, stopping: false, completedGames: 0, targetGames: 0,
    startedAt: null, endedAt: null, point: null, history: [], checkpoint: '', error: '', logs: [],
    hardware: { cpu: os.cpus()[0] && os.cpus()[0].model, logicalCores: os.cpus().length,
      memoryGB: +(os.totalmem() / 2 ** 30).toFixed(1), runtime: process.version }
  };

  function appendLog(text) {
    const line = String(text || '').trim();
    if (!line) return;
    status.logs.push({ at: new Date().toISOString(), text: line.slice(0, 800) });
    if (status.logs.length > 80) status.logs.shift();
  }

  function checkpoints() {
    try {
      return fs.readdirSync(dataDir)
        .filter(name => /^checkpoint-\d+\.json\.gz$/.test(name))
        .sort().reverse().slice(0, 40)
        .map(name => ({ name, bytes: fs.statSync(path.join(dataDir, name)).size }));
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
        config: undefined, point: null, history: [], checkpoint: '', error: '', logs: [] };
    }
    return { ...status, checkpoints: storedCheckpoints, pid: child && child.pid || null };
  }

  function start(rawConfig) {
    if (child) throw new Error('训练已经在运行');
    const config = sanitizeConfig(rawConfig);
    fs.mkdirSync(dataDir, { recursive: true });
    if (config.resumeCheckpoint) {
      const checkpointFile = path.join(dataDir, config.resumeCheckpoint);
      if (!/^checkpoint-\d+\.json\.gz$/.test(config.resumeCheckpoint) || !fs.existsSync(checkpointFile)) {
        throw new Error('要继续的 checkpoint 不存在，请刷新页面后重新选择，或选择从头训练');
      }
    }
    status = { ...status, state: 'starting', running: true, stopping: false,
      completedGames: 0, targetGames: config.targetGames, startedAt: new Date().toISOString(), endedAt: null,
      config, point: null, history: [], checkpoint: '', error: '', logs: [] };
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
    });
    return snapshot();
  }

  function stop() {
    if (!child || !status.running) return snapshot();
    status.stopping = true; status.state = 'stopping';
    try { child.send({ type: 'stop' }); } catch (_) { /* exit handler will settle */ }
    forceTimer = setTimeout(() => {
      if (child) { appendLog('优雅停止超时，终止训练子进程'); child.kill(); }
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
