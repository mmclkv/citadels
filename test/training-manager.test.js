'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTrainingManager } = require('../lib/training-manager.js');

class FakeStream extends EventEmitter {}
class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 4321; this.stdout = new FakeStream(); this.stderr = new FakeStream(); this.sent = []; }
  send(message) { this.sent.push(message); }
  kill() { this.emit('exit', null, 'SIGTERM'); }
}
let child;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-training-manager-'));
const dataDir = path.join(root, 'training-data');
fs.mkdirSync(dataDir, { recursive: true });
const manager = createTrainingManager({ root, forkImpl: () => (child = new FakeChild()) });
let status = manager.start({ targetGames: 10, minPlayers: 4, maxPlayers: 5, profile: 'balanced' });
assert.ok(status.running && status.state === 'starting', '开始训练会创建独立子进程');
child.emit('message', { type: 'started', parameterCount: 320898, completedGames: 0 });
child.emit('message', { type: 'progress', point: { game: 3, totalLoss: 0.5 }, history: [{ game: 3 }] });
status = manager.status();
assert.strictEqual(status.completedGames, 3, '训练进度可从子进程同步');
assert.strictEqual(status.parameterCount, 320898, '展示真实参数量');
status = manager.stop();
assert.ok(status.stopping && child.sent.some(x => x.type === 'stop'), '停止训练先发送优雅停止请求');
fs.writeFileSync(path.join(dataDir, 'checkpoint-000003.json.gz'), 'test');
child.emit('message', { type: 'stopped', completedGames: 3, checkpoint: 'checkpoint-000003.json.gz' });
child.emit('exit', 0, null);
status = manager.status();
assert.ok(!status.running && status.state === 'stopped', '停止后保留最终状态');
assert.strictEqual(status.checkpoint, 'checkpoint-000003.json.gz', '停止时记录最终 checkpoint');

fs.unlinkSync(path.join(dataDir, 'checkpoint-000003.json.gz'));
status = manager.status();
assert.strictEqual(status.state, 'idle', '磁盘中已无 checkpoint 时清除已完成状态');
assert.strictEqual(status.completedGames, 0, '磁盘中已无 checkpoint 时训练局数归零');
assert.strictEqual(status.checkpoint, '', '磁盘中已无 checkpoint 时清除最近存档引用');
assert.strictEqual(status.point, null, '磁盘中已无 checkpoint 时清除旧指标');

assert.throws(
  () => manager.start({ targetGames: 2, resumeCheckpoint: 'checkpoint-000003.json.gz' }),
  /checkpoint 不存在/,
  '不存在的续训 checkpoint 会在创建训练进程前被拒绝'
);

status = manager.start({ targetGames: 1, minPlayers: 2, maxPlayers: 2, profile: 'fast' });
fs.writeFileSync(path.join(dataDir, 'checkpoint-000001.json.gz'), 'test');
child.emit('message', { type: 'completed', completedGames: 1, checkpoint: 'checkpoint-000001.json.gz' });
const sentBefore = child.sent.length;
status = manager.stop();
assert.strictEqual(status.state, 'completed', '已完成的训练不会被停止操作改回正在停止');
assert.strictEqual(child.sent.length, sentBefore, '已完成的训练不会收到多余停止指令');
child.emit('exit', 0, null);
status = manager.start({ targetGames: 2, minPlayers: 2, maxPlayers: 2, profile: 'fast' });
assert.strictEqual(status.state, 'starting', '上一训练进程退出后可立即开始下一次训练');
child.emit('exit', 0, null);

fs.rmSync(root, { recursive: true, force: true });

console.log('训练管理器：开始、进度同步、停止与 checkpoint 状态全部通过');
