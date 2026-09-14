const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ 客户端可从真实 gpu_trainer/PyTorch 获取批量策略和值', { timeout: 120000 }, () => {
  const exe = process.env.CITADELS_NATIVE_GPU_TRAINER_E2E_PROBE;
  const python = process.env.CITADELS_PYTHON;
  const script = process.env.CITADELS_GPU_TRAINER_SCRIPT;
  const model = process.env.CITADELS_GPU_MODEL;
  if (!exe || !python || !script || !model) return;
  const [batch, first, second, values, probability, value] = execFileSync(
    exe, [python, script, model], { encoding: 'utf8', timeout: 110000 }
  ).trim().split(',').map(Number);
  assert.equal(batch, 2);
  assert.equal(first, 2);
  assert.equal(second, 1);
  assert.equal(values, 2);
  assert.ok(Number.isFinite(probability) && probability >= 0 && probability <= 1);
  assert.ok(Number.isFinite(value));
});
