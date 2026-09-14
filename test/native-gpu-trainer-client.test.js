const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ gpu_trainer 长驻协议客户端可编码并解析批量策略和值', () => {
  const exe = process.env.CITADELS_NATIVE_GPU_TRAINER_CLIENT_PROBE;
  if (!exe) return;
  assert.equal(execFileSync(exe, { encoding: 'utf8' }).trim(), '1,2,0.75,-0.25');
});
