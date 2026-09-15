'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeConfig } = require('../training/train.js');

test('native 训练配置保留 C++ 搜索 worker 路径', () => {
  const config = sanitizeConfig({ backend: 'native', nativeSearchWorker: 'C:/native/mcts_worker.exe' });
  assert.equal(config.backend, 'native');
  assert.equal(config.nativeSearchWorker, 'C:/native/mcts_worker.exe');
});
