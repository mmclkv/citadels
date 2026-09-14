'use strict';
// 端到端验证：构造一批带 π 的 transition → 序列化（按 torch-bridge 的方式）→ 喂给 gpu_trainer.py
// 让它在新代码路径（交叉熵 against π）下跑通，并打印关键指标。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const python = path.join(root, '.python', 'python.exe');
if (!fs.existsSync(python)) {
  console.log('MCTS rollout 测试：跳过（未安装项目私有 PyTorch）');
  process.exit(0);
}

const N = 8;          // transitions 数量
const NA = 6;         // 每条 transition 的合法动作数量（≤64）
const STATE = 192;
const ACT = 64;

const transitions = [];
for (let i = 0; i < N; i++) {
  const actions = [];
  for (let j = 0; j < NA; j++) {
    const v = new Float32Array(ACT);
    for (let k = 0; k < ACT; k++) v[k] = ((i + j + k) % 17) / 17;
    actions.push(Array.from(v));
  }
  const pi = new Float32Array(NA);
  let s = 0;
  for (let j = 0; j < NA; j++) { pi[j] = ((i * 3 + j) % 7) / 7 + 0.1; s += pi[j]; }
  for (let j = 0; j < NA; j++) pi[j] /= s;
  transitions.push({
    state: Array.from(new Float32Array(STATE).map((_, k) => ((i + k) % 11) / 11 - 0.5)),
    actions,
    chosen: i % NA,
    oldProb: pi[i % NA],
    oldValue: (i % 7) / 7 - 0.5,
    reward: ((i % 13) / 13 - 0.5) * 1.6,
    temperature: 1,
    pi: Array.from(pi),
    mctsValue: (i % 7) / 7 - 0.5
  });
}

const rolloutPath = path.join(root, 'training-data', 'mcts-rollout-smoke.json.gz');
fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
fs.writeFileSync(rolloutPath, zlib.gzipSync(JSON.stringify(transitions), { level: 1 }));

// 用 Python 直接对 rollout 做 load_rollout + train_ppo (CPU 模式即可)
const pyScript = `
import sys, json, gzip, torch
sys.path.insert(0, ${JSON.stringify(path.join(root, 'training').replace(/\\/g, '/'))})
from gpu_trainer import PolicyValueNet, load_rollout, train_ppo
import torch
model = PolicyValueNet('fast')
# 复制 train.js 的 local-neural-bot 那边的随机初始化太麻烦，这里直接随机一下
for p in model.parameters(): p.data = (torch.randn_like(p.data) * 0.02)
optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
data = load_rollout(${JSON.stringify(rolloutPath.replace(/\\/g, '/'))})
print('pi present:', 'pi' in data, 'pi shape:', tuple(data['pi'].shape) if 'pi' in data else 'absent')
metrics = train_ppo(model, optimizer, torch.device('cpu'), data, epochs=1, batch_size=4)
print('METRICS', json.dumps(metrics))
`.trim();

const run = spawnSync(python, ['-c', pyScript], {
  cwd: root, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, PYTHONUTF8: '1' }
});
fs.unlinkSync(rolloutPath);
if (run.status !== 0) {
  console.error(run.stdout || run.stderr);
  process.exit(1);
}
// 找 METRICS 行
let metricLine = null;
let piPresentLine = null;
for (const line of (run.stdout || '').split(/\r?\n/)) {
  if (line.startsWith('METRICS ')) metricLine = line.slice(8);
  if (line.startsWith('pi present:')) piPresentLine = line.trim();
}
assert.ok(metricLine, '应当输出 METRICS 行');
assert.ok(piPresentLine, '应当输出 pi present 信息');
console.log(piPresentLine);
const metrics = JSON.parse(metricLine);
assert.ok(Number.isFinite(metrics.policyLoss), '策略损失是有效数字：' + metrics.policyLoss);
assert.ok(metrics.clipFraction === 0, 'MCTS 路径不计算 clip fraction：' + metrics.clipFraction);
assert.ok(Number.isFinite(metrics.valueLoss) && metrics.valueLoss > 0, '价值损失是正数');
console.log('GPU π 训练路径：' + JSON.stringify({ policyLoss: metrics.policyLoss, valueLoss: metrics.valueLoss,
  entropy: metrics.entropy, approxKl: metrics.approxKl, clipFraction: metrics.clipFraction }));
