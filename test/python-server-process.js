'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const pythonScript = path.join(root, 'python_backend', 'run.py');

function pythonExecutable() {
  if (process.env.CITADELS_PYTHON) return process.env.CITADELS_PYTHON;
  const candidates = process.platform === 'win32'
    ? [path.join(root, '.python', 'python.exe'), path.join(root, '.venv', 'Scripts', 'python.exe')]
    : [path.join(root, '.python', 'bin', 'python'), path.join(root, '.venv', 'bin', 'python')];
  return candidates.find(candidate => fs.existsSync(candidate)) ||
    (process.platform === 'win32' ? 'python' : 'python3');
}

async function startPythonServer(extraEnv = {}, timeoutMs = 20000) {
  let port = null;
  let output = '';
  const child = spawn(pythonExecutable(), [pythonScript, '0'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ...extraEnv, CITADELS_ALLOW_EPHEMERAL_PORT: '1',
      PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const capture = chunk => {
    output = (output + chunk.toString('utf8')).slice(-16000);
    if (port != null) return;
    const match = output.match(/Python Citadels 服务器已启动[：:][^\r\n]*?\('(\S+)',\s*(\d+)\)/);
    if (match) port = Number(match[2]);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (port == null && child.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (port == null) {
    await close();
    throw new Error('Python server failed to start: ' + output);
  }
  return { child, base: `http://127.0.0.1:${port}`, close, output: () => output };
}

module.exports = { startPythonServer };
