'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const python = path.join(root, '.python', 'python.exe');
if (!fs.existsSync(python)) {
  console.log('GPU 训练测试：跳过（未安装项目私有 PyTorch 环境）');
  process.exit(0);
}
const config = {
  targetGames: 2, minPlayers: 2, maxPlayers: 2, charSet: 'base', endDistricts: 7,
  profile: 'fast', backend: 'gpu', batchGames: 2, workers: 2, ppoEpochs: 1,
  miniBatch: 128, checkpointEvery: 2, seed: 9917
};
const run = spawnSync(process.execPath, [path.join(root, 'training', 'train.js')], {
  cwd: root, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, CITADELS_TRAIN_CONFIG: JSON.stringify(config) }
});
assert.strictEqual(run.status, 0, run.stderr || run.stdout);
const messages = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
const started = messages.find(message => message.type === 'started');
const progress = messages.find(message => message.type === 'progress');
const completed = messages.find(message => message.type === 'completed');
assert.strictEqual(started.hardware.device, 'cuda', 'PyTorch 训练确实使用 CUDA');
assert.match(started.hardware.gpu, /GTX 1660 SUPER/i, '识别本机 NVIDIA GPU');
assert.ok(progress.point.gradientNorm > 0, 'GPU 反向传播产生非零梯度');
assert.ok(Number.isFinite(progress.point.policyLoss), '策略损失按真实精度输出');
assert.ok(progress.point.gpuMemoryMB > 0, '记录 CUDA 峰值显存');
assert.strictEqual(completed.completedGames, 2, 'GPU 训练完成并行自对弈批次');
console.log('GPU 训练：CUDA、并行轨迹、PPO 梯度和指标全部通过');
