'use strict';
// rollout 二进制格式（training/rollout-format.js + gpu_trainer.load_rollout）回归。
//
// 锁住三件事：
//   ① 布局契约：头部字段、块顺序与偏移、文件总长；
//   ② 分块性质：无论多少条样本，单次交给 fs.writeSync 的字节数都有上界
//      （旧路径会在主进程里物化整批 JSON 字符串，256 局一批额外驻留 2676 MB）；
//   ③ 语义等价：JS 编码 → Python 解码，dtype/shape/数值/缺省字段与旧 JSON
//      读取器逐条一致，含「部分行有 π」的混合批。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const format = require(path.join(root, 'training', 'rollout-format.js'));
const { TorchBridge } = require(path.join(root, 'training', 'torch-bridge.js'));

const python = path.join(root, '.python', 'python.exe');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-bin-'));
  return path.join(dir, name);
}

// 造一批形状可控的样本：pi 只给部分行，用来覆盖「混合批」的 π 索引。
function makeTransitions({ rows = 5, stateSize = 8, actionSize = 4, piEvery = 1 } = {}) {
  const out = [];
  for (let i = 0; i < rows; i++) {
    const actionCount = 1 + (i % 3);
    const actions = [];
    for (let j = 0; j < actionCount; j++) {
      const v = new Float32Array(actionSize);
      for (let k = 0; k < actionSize; k++) v[k] = (i + j + k) / 8;
      actions.push(v);
    }
    const state = new Float32Array(stateSize);
    for (let k = 0; k < stateSize; k++) state[k] = (i * stateSize + k) / 16 - 0.5;
    const row = {
      state, actions, chosen: i % actionCount, oldProb: 0.25 * (i + 1),
      oldValue: i / 10, reward: i / 20, temperature: 1 + i / 10,
      oldValueVector: Float32Array.from({ length: 8 }, (_, k) => k + i),
      rewardVector: Float32Array.from({ length: 8 }, (_, k) => -(k + i)),
      valueMask: Float32Array.from({ length: 8 }, (_, k) => (k < 5 ? 1 : 0)),
      mctsValue: i / 30,
      mctsValueVector: Float32Array.from({ length: 8 }, (_, k) => k - i)
    };
    if (piEvery && i % piEvery === 0) {
      const pi = new Float32Array(actionCount);
      let sum = 0;
      for (let j = 0; j < actionCount; j++) { pi[j] = j + 1; sum += pi[j]; }
      for (let j = 0; j < actionCount; j++) pi[j] /= sum;
      row.pi = pi;
    }
    out.push(row);
  }
  return out;
}

test('布局契约：头部字段、块偏移与文件总长一致', () => {
  const transitions = makeTransitions({ rows: 5 });
  const file = tmpFile('layout.ctrl');
  const result = format.writeRollout(file, transitions, { chunkBytes: 4096 });
  const header = format.readHeader(fs.readFileSync(file).subarray(0, format.HEADER_BYTES));
  const slots = transitions.reduce((sum, row) => sum + row.actions.length, 0);
  const piSlots = transitions.reduce((sum, row) => sum + (row.pi ? row.actions.length : 0), 0);
  assert.equal(header.rowCount, 5);
  assert.equal(header.actionSlots, slots);
  assert.equal(header.piSlots, piSlots);
  assert.equal(header.stateSize, 8);
  assert.equal(header.actionSize, 4);
  assert.equal(header.valueSlots, 8);
  // 布局里每一块的 offset 必须等于前一块的结尾（无空洞、无重叠）
  let cursor = format.HEADER_BYTES;
  for (const entry of result.layout) {
    assert.equal(entry.offset, cursor, entry.name + ' 的 offset 应紧接前一块');
    cursor += entry.bytes;
  }
  assert.equal(result.bytes, cursor, '文件总长应等于布局末尾');
  assert.equal(fs.statSync(file).size, result.bytes, '磁盘上的文件大小应与返回值一致');
});

test('分块性质：样本越多单次写入也越小（不会退化成整批一次性分配）', () => {
  const small = makeTransitions({ rows: 200, stateSize: 64, actionSize: 32, piEvery: 1 });
  const huge = makeTransitions({ rows: 20000, stateSize: 64, actionSize: 32, piEvery: 1 });
  const chunkBytes = 64 * 1024;
  const a = format.writeRollout(tmpFile('small.ctrl'), small, { chunkBytes });
  const b = format.writeRollout(tmpFile('huge.ctrl'), huge, { chunkBytes });
  assert.ok(b.bytes > a.bytes * 50, '样本量放大后文件应显著变大（' + a.bytes + ' → ' + b.bytes + '）');
  assert.ok(a.maxWrite <= chunkBytes, '小批单次写入 ' + a.maxWrite + ' 应不超过 chunkBytes');
  assert.ok(b.maxWrite <= chunkBytes,
    '大批单次写入 ' + b.maxWrite + ' 应不超过 chunkBytes（否则等于把整批物化进内存）');
  // 旧路径在 256 局（约 8 万条）时序列化阶段额外驻留 2676 MB；
  // 分块后同样的批量只占一个 chunkBytes 级别的复用缓冲。
  assert.ok(b.bytes > 8 * 1024 * 1024, '大批文件应有量级（' + b.bytes + ' 字节）');
});

test('编码 → 解码往返：数值与缺省字段语义一致', () => {
  const transitions = makeTransitions({ rows: 7, piEvery: 2 });
  const file = tmpFile('roundtrip.ctrl');
  format.writeRollout(file, transitions, { chunkBytes: 4096 });
  const decoded = format.decodeRollout(fs.readFileSync(file));
  assert.equal(decoded.rows.length, transitions.length);
  transitions.forEach((source, i) => {
    const row = decoded.rows[i];
    assert.equal(row.chosen, source.chosen, '第 ' + i + ' 行 chosen');
    assert.equal(row.oldProb, Math.fround(source.oldProb), '第 ' + i + ' 行 oldProb');
    assert.equal(row.temperature, Math.fround(source.temperature), '第 ' + i + ' 行 temperature');
    assert.equal(row.mctsValue, Math.fround(source.mctsValue), '第 ' + i + ' 行 mctsValue');
    assert.equal(row.actions.length, source.actions.length, '第 ' + i + ' 行动作数');
    source.state.forEach((v, k) => assert.equal(row.state[k], Math.fround(v), '第 ' + i + ' 行 state[' + k + ']'));
    for (let j = 0; j < source.actions.length; j++) {
      for (let k = 0; k < source.actions[j].length; k++) {
        assert.equal(row.actions[j][k], Math.fround(source.actions[j][k]), '动作向量第 ' + i + '/' + j + '/' + k);
      }
    }
    for (let k = 0; k < 8; k++) {
      assert.equal(row.oldValueVector[k], Math.fround(source.oldValueVector[k]), 'oldValueVector[' + k + ']');
      assert.equal(row.rewardVector[k], Math.fround(source.rewardVector[k]), 'rewardVector[' + k + ']');
      assert.equal(row.valueMask[k], Math.fround(source.valueMask[k]), 'valueMask[' + k + ']');
      assert.equal(row.mctsValueVector[k], Math.fround(source.mctsValueVector[k]), 'mctsValueVector[' + k + ']');
    }
    if (source.pi) {
      assert.ok(row.pi, '第 ' + i + ' 行应带 π');
      source.pi.forEach((v, k) => assert.equal(row.pi[k], Math.fround(v), 'π[' + k + ']'));
    } else {
      assert.equal(row.pi, null, '第 ' + i + ' 行不应带 π');
    }
  });
});

test('缺省字段：无 valueMask / pi 的行与旧 JSON 读取器同构', () => {
  const transitions = [{
    state: new Float32Array(4).fill(0.5),
    actions: [new Float32Array(3).fill(0.25), new Float32Array(3).fill(0.75)],
    chosen: 1, oldProb: 0.5, oldValue: 0.3, reward: -0.2
  }];
  const file = tmpFile('defaults.ctrl');
  format.writeRollout(file, transitions, { chunkBytes: 4096 });
  const row = format.decodeRollout(fs.readFileSync(file)).rows[0];
  assert.equal(row.temperature, 1, 'temperature 缺省 1');
  assert.deepEqual(Array.from(row.oldValueVector), [Math.fround(0.3), 0, 0, 0, 0, 0, 0, 0],
    'oldValueVector 缺省为 [oldValue] 补零');
  assert.deepEqual(Array.from(row.rewardVector), [Math.fround(-0.2), 0, 0, 0, 0, 0, 0, 0],
    'rewardVector 缺省为 [reward] 补零');
  assert.deepEqual(Array.from(row.valueMask), [1, 0, 0, 0, 0, 0, 0, 0],
    'valueMask 缺省为 [1] 补零');
  assert.equal(row.pi, null, 'pi 缺失时该行不带 π');
});

test('Python 读取器：dtype/shape/数值与 JS 编码逐条一致', t => {
  if (!fs.existsSync(python)) {
    t.skip('未安装项目私有 PyTorch，跳过');
    return;
  }
  const transitions = makeTransitions({ rows: 6, stateSize: 8, actionSize: 4, piEvery: 2 });
  const file = tmpFile('python.ctrl');
  const written = format.writeRollout(file, transitions, { chunkBytes: 4096 });
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'training').replace(/\\/g, '/'))})
from gpu_trainer import load_rollout
data = load_rollout(${JSON.stringify(file.replace(/\\/g, '/'))})
summary = {
    'statesShape': list(data['states'].shape),
    'statesDtype': str(data['states'].dtype),
    'actionsShape': list(data['actions_flat'].shape),
    'lengths': [int(v) for v in data['lengths']],
    'offsets': [int(v) for v in data['offsets']],
    'chosenDtype': str(data['chosen'].dtype),
    'chosen': [int(v) for v in data['chosen']],
    'lengthsDtype': str(data['lengths'].dtype),
    'piIsNone': data['pi_flat'] is None,
    'piOffsets': None if data['pi_offsets'] is None else [int(v) for v in data['pi_offsets']],
    'piLengths': None if data['pi_lengths'] is None else [int(v) for v in data['pi_lengths']],
    'piSum': None if data['pi_flat'] is None else float(data['pi_flat'].sum()),
    'oldValueVector0': [float(v) for v in data['old_values'][0]],
    'valueMask0': [float(v) for v in data['value_masks'][0]],
    'rewardVector1': [float(v) for v in data['rewards'][1]],
    'actionWidth': int(data['action_width']),
    'statesRow1': [float(v) for v in data['states'][1]],
    'actionsRow0': [float(v) for v in data['actions_flat'][0]],
    'fileBytes': ${written.bytes},
}
print(json.dumps(summary))
`;
  const run = spawnSync(python, ['-c', script], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONUTF8: '1' }
  });
  assert.equal(run.status, 0, 'Python 读取失败：' + (run.stderr || run.stdout));
  const summary = JSON.parse(run.stdout.trim().split(/\r?\n/).pop());

  const counts = transitions.map(row => row.actions.length);
  const slots = counts.reduce((a, b) => a + b, 0);
  const expectedPiLengths = transitions.map(row => (row.pi ? row.actions.length : 0));
  const expectedPiOffsets = [0];
  expectedPiLengths.forEach(n => expectedPiOffsets.push(expectedPiOffsets[expectedPiOffsets.length - 1] + n));

  assert.deepEqual(summary.statesShape, [6, 8]);
  assert.deepEqual(summary.actionsShape, [slots, 4]);
  assert.equal(summary.statesDtype, 'torch.float32', 'states 直接 torch.from_numpy，不做 dtype 转换');
  assert.equal(summary.chosenDtype, 'torch.int64', 'chosen 必须是 int64（scatter_ 需要）');
  assert.equal(summary.lengthsDtype, 'int64');
  assert.deepEqual(summary.lengths, counts);
  assert.deepEqual(summary.offsets, [0].concat(counts.map((_, i) => counts.slice(0, i + 1).reduce((a, b) => a + b, 0))));
  assert.deepEqual(summary.chosen, transitions.map(row => row.chosen));
  assert.equal(summary.piIsNone, false, '本例有 π，不应退化成 None');
  assert.deepEqual(summary.piLengths, expectedPiLengths, 'pi_lengths 应与旧实现一致（无 π 的行记 0）');
  assert.deepEqual(summary.piOffsets, expectedPiOffsets, 'pi_offsets 应只累计有 π 的行');
  const expectedPiSum = transitions.reduce((sum, row) => sum + (row.pi ? Array.from(row.pi).reduce((a, b) => a + b, 0) : 0), 0);
  assert.ok(Math.abs(summary.piSum - expectedPiSum) < 1e-3, 'π 数值应与 JS 编码一致');
  assert.equal(summary.actionWidth, 4);
  assert.deepEqual(summary.valueMask0, [1, 1, 1, 1, 1, 0, 0, 0], '第一行 valueMask 应原样读回');
  assert.deepEqual(summary.rewardVector1.slice(0, 3), [-1, -2, -3], '第二轮 rewardVector 应原样读回');
  transitions[1].state.forEach((v, k) => {
    assert.equal(summary.statesRow1[k], Math.fround(v), 'states[1][' + k + ']');
  });
  transitions[0].actions[0].forEach((v, k) => {
    assert.equal(summary.actionsRow0[k], Math.fround(v), 'actions_flat[0][' + k + ']');
  });
});

test('Python 读取器：整批都没有 π 时三个 π 字段都退化为 None', t => {
  if (!fs.existsSync(python)) {
    t.skip('未安装项目私有 PyTorch，跳过');
    return;
  }
  const transitions = makeTransitions({ rows: 4, piEvery: 0 });
  const file = tmpFile('nopi.ctrl');
  format.writeRollout(file, transitions, { chunkBytes: 4096 });
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'training').replace(/\\/g, '/'))})
from gpu_trainer import load_rollout
data = load_rollout(${JSON.stringify(file.replace(/\\/g, '/'))})
print(json.dumps({
    'piFlat': data['pi_flat'] is None,
    'piOffsets': data['pi_offsets'] is None,
    'piLengths': data['pi_lengths'] is None,
    'lengths': [int(v) for v in data['lengths']],
}))
`;
  const run = spawnSync(python, ['-c', script], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONUTF8: '1' }
  });
  assert.equal(run.status, 0, 'Python 读取失败：' + (run.stderr || run.stdout));
  const summary = JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
  assert.equal(summary.piFlat, true, 'pi_flat 应为 None');
  assert.equal(summary.piOffsets, true, 'pi_offsets 应为 None');
  assert.equal(summary.piLengths, true, 'pi_lengths 应为 None');
  assert.deepEqual(summary.lengths, [1, 2, 3, 1]);
});

test('Python 读取器：损坏文件必须报错而不是静默跑错数据', t => {
  if (!fs.existsSync(python)) {
    t.skip('未安装项目私有 PyTorch，跳过');
    return;
  }
  const transitions = makeTransitions({ rows: 4 });
  const file = tmpFile('truncated.ctrl');
  format.writeRollout(file, transitions, { chunkBytes: 4096 });
  const full = fs.readFileSync(file);
  fs.writeFileSync(file, full.subarray(0, full.length - 8));   // 截掉尾部
  const bad = tmpFile('badmagic.ctrl');
  const wrong = Buffer.from(full);
  wrong.write('XXXX', 0, 'ascii');
  fs.writeFileSync(bad, wrong);
  for (const [target, hint] of [[file, '截断'], [bad, '魔数']]) {
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'training').replace(/\\/g, '/'))})
from gpu_trainer import load_rollout
try:
    load_rollout(${JSON.stringify(target.replace(/\\/g, '/'))})
    print('NO_ERROR')
except Exception as error:
    print('ERROR:' + type(error).__name__)
`;
    const run = spawnSync(python, ['-c', script], {
      cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONUTF8: '1' }
    });
    assert.equal(run.status, 0, 'Python 执行失败：' + (run.stderr || run.stdout));
    assert.match(run.stdout, /^ERROR:/m, hint + '的 rollout 必须抛错，实际输出：' + run.stdout.trim());
  }
});

test('torch-bridge：train 走二进制 rollout 文件（真实接线，非模块自测）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-bridge-'));
  const bridge = new TorchBridge({ root: tmp, model: {}, config: { profile: 'balanced' } });
  bridge.dataDir = tmp;
  bridge.readModel = () => {};
  let captured = null;
  let requestedPath = '';
  bridge.child = {
    stdin: { write: (text) => {
      const message = JSON.parse(text);
      requestedPath = message.rolloutPath || '';
      if (message.rolloutPath) captured = fs.readFileSync(message.rolloutPath);
      setTimeout(() => {
        const entry = bridge.pending.shift();
        if (entry) entry.resolve({ ok: true, metrics: { policyLoss: 0.1, valueLoss: 0.1, totalLoss: 0.2,
          entropy: 0.5, clipFraction: 0, approxKl: 0, gradientNorm: 1, samples: 3 } });
      }, 0);
    } },
    stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {}
  };
  const metrics = await bridge.train(makeTransitions({ rows: 3, stateSize: 8, actionSize: 4 }));
  assert.ok(metrics, 'train 应返回指标');
  assert.ok(requestedPath.endsWith('.bin'), 'rollout 临时文件应是 .bin，实际 ' + requestedPath);
  assert.ok(captured, '假 child 应能读到 rollout 文件');
  const header = format.readHeader(captured.subarray(0, format.HEADER_BYTES));
  assert.equal(header.rowCount, 3, '训练器拿到的样本条数应与输入一致');
  assert.equal(header.stateSize, 8);
  assert.equal(header.actionSize, 4);
  assert.equal(fs.existsSync(requestedPath), false, '训练结束后临时 rollout 必须被删掉');
  assert.equal(fs.readdirSync(tmp).filter(name => name.startsWith('rollout-')).length, 0,
    '临时目录里不应残留 rollout 文件');
});

test('torch-bridge 源码不再走 JSON 序列化路径（防止回退）', () => {
  const source = fs.readFileSync(path.join(root, 'training', 'torch-bridge.js'), 'utf8');
  assert.ok(/writeRollout\(/.test(source), 'torch-bridge 应调用 writeRollout');
  assert.ok(!/JSON\.stringify\(serializable\)/.test(source), '不应再物化整批 JSON 字符串');
  assert.ok(!/gzipSync/.test(source), 'rollout 不应再经 gzip 缓冲');
  assert.ok(!/Array\.from\(row\.state\)/.test(source), '不应再逐行 Array.from 复制成 double 数组');
});
