'use strict';

// Exercise the supported Python/PyTorch training CLI, not the retired JS trainer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const python = process.platform === 'win32'
  ? path.join(root, '.python', 'python.exe')
  : path.join(root, '.python', 'bin', 'python');
if (!fs.existsSync(python)) {
  console.log('Python GPU 训练测试：跳过（未安装项目私有 Python 环境）');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-python-gpu-train-'));
try {
  const configPath = path.join(temp, 'config.json');
  const dataDir = path.join(temp, 'training-data');
  const config = {
    targetGames: 2, minPlayers: 2, maxPlayers: 2, charSet: 'base', endDistricts: 7,
    profile: 'fast', networkArchitecture: 'flat', device: 'cuda',
    batchGames: 2, workers: 2, ppoEpochs: 1, miniBatch: 128,
    checkpointEvery: 2, maxRounds: 1, seed: 9917
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const run = spawnSync(python, [path.join(root, 'python_backend', 'train.py'), configPath,
    '--data-dir', dataDir], { cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  const output = (run.stdout || '') + (run.stderr || '');
  assert.strictEqual(run.status, 0, output);
  assert.match(output, /Python 训练启动/);
  assert.match(output, /设备=cuda/, '训练入口须确实走 PyTorch CUDA 设备');
  assert.match(output, /\[train\] 完成：2 局；checkpoint=/);
  const checkpoints = fs.readdirSync(dataDir).filter(name => /^checkpoint-.*\.json\.gz$/.test(name));
  assert.equal(checkpoints.length, 1, 'Python CLI 应在指定目录保存训练 checkpoint');
  console.log('Python GPU 训练 CLI：CUDA、两局自对弈与 checkpoint 保存通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
