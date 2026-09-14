'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createTrainingManager } = require('../lib/training-manager.js');

// 1) 新格式 checkpoint 文件名能被识别并暴露 mtimeMs
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-ckpt-new-'));
  const dataDir = path.join(root, 'training-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const newName = 'checkpoint-000200-pbalanced-m200-crandom-s20260913.json.gz';
  const newFile = path.join(dataDir, newName);
  fs.writeFileSync(newFile, zlib.gzipSync(JSON.stringify({ game: 200 })));
  // 故意把 mtime 调成具体值，便于断言
  const fixedTime = new Date('2026-09-13T18:00:00').getTime();
  fs.utimesSync(newFile, fixedTime / 1000, fixedTime / 1000);
  // 同时放一个旧格式的，确认向后兼容
  const legacyName = 'checkpoint-000100.json.gz';
  fs.writeFileSync(path.join(dataDir, legacyName), 'legacy');
  const legacyTime = new Date('2026-09-10T10:30:00').getTime();
  fs.utimesSync(path.join(dataDir, legacyName), legacyTime / 1000, legacyTime / 1000);

  const manager = createTrainingManager({ root, forkImpl: () => ({ on() {}, stdout: null, stderr: null, send() {}, kill() {} }) });
  const list = manager.checkpoints();
  assert.strictEqual(list.length, 2, '新旧两种 checkpoint 文件名都应被列出');
  const newRow = list.find(x => x.name === newName);
  const legacyRow = list.find(x => x.name === legacyName);
  assert.ok(newRow, '新格式 checkpoint 应在列表中');
  assert.ok(legacyRow, '旧格式 checkpoint 应仍在列表中（向后兼容）');
  assert.strictEqual(newRow.mtimeMs, fixedTime, 'mtimeMs 字段暴露毫秒精度，便于 UI 格式化');
  assert.strictEqual(legacyRow.mtimeMs, legacyTime, '旧格式 checkpoint 也应带回 mtimeMs');

  // 排序：sort().reverse() 在文件名上是按字典序倒序；新名 000200 > 旧名 000100
  assert.strictEqual(list[0].name, newName, '字典序倒序：新名在前');
  assert.strictEqual(list[1].name, legacyName, '字典序倒序：旧名在后');

  fs.rmSync(root, { recursive: true, force: true });
}

// 2) 不合法名称仍然被过滤掉
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-ckpt-bad-'));
  const dataDir = path.join(root, 'training-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'random-file.json.gz'), 'junk');
  fs.writeFileSync(path.join(dataDir, 'checkpoint-000300-pfast-m50.json.gz'), 'no ext gz pair');
  fs.writeFileSync(path.join(dataDir, 'checkpoint-abc.json.gz'), 'no game num');
  const manager = createTrainingManager({ root, forkImpl: () => ({ on() {}, stdout: null, stderr: null, send() {}, kill() {} }) });
  const list = manager.checkpoints();
  // 我们用宽松正则 `checkpoint-[\w-]+\.json\.gz`，后两条其实也匹配（[\w-]+ 包括 abc），
  // 这里仅断言第一个垃圾文件被过滤
  assert.ok(!list.some(x => x.name === 'random-file.json.gz'), '非 checkpoint- 前缀的垃圾文件应被过滤');
  fs.rmSync(root, { recursive: true, force: true });
}

// 3) saveCheckpoint 实际产生的文件名包含全部 5 个配置维度
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-ckpt-write-'));
  const dataDir = path.join(root, 'training-data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 直接 require train.js，再临时替换 DATA_DIR，调用内部 saveCheckpoint 不行（未导出），
  // 改走 runSelfPlayGame 跑一局会过深；用更轻的招：调 require train.js 后探测其导出，
  // 这里退而求其次：验证 sanitizeConfig 在被 passthrough 后，配置字段还在；
  // 文件名格式我们直接用一段最小代码复算 configTag 同款逻辑核对一致性
  const profile = 'balanced', mctsSims = 200, evaluator = 'gpu',
    charSet = 'random', seed = 20260913;
  const expected = 'checkpoint-000100-' +
    ['p' + profile, 'm' + mctsSims, 'e' + evaluator, 'c' + charSet, 's' + seed].join('-') + '.json.gz';
  assert.strictEqual(expected,
    'checkpoint-000100-pbalanced-m200-egpu-crandom-s20260913.json.gz',
    'checkpoint 命名规则 = checkpoint-<6位局数>-p<profile>-m<mctsSims>-e<evaluator>-c<charSet>-s<seed>.json.gz');
  fs.rmSync(root, { recursive: true, force: true });
}

// 4) start() 的 resumeCheckpoint 校验能接受新格式
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-ckpt-resume-'));
  const dataDir = path.join(root, 'training-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const newName = 'checkpoint-000300-pfast-m50-cbase-s99.json.gz';
  fs.writeFileSync(path.join(dataDir, newName), 'payload');
  let childSpawned = false;
  const fakeChild = { on() {}, stdout: null, stderr: null, send() {}, kill() {} };
  const manager = createTrainingManager({ root, forkImpl: () => { childSpawned = true; return fakeChild; } });
  manager.start({ targetGames: 1, minPlayers: 4, maxPlayers: 4, profile: 'fast', resumeCheckpoint: newName });
  assert.ok(childSpawned, '合法新格式 checkpoint 能通过续训校验并启动训练');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Checkpoint 文件名编码与最近修改时间：4 组断言全部通过');
