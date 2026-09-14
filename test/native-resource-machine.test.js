'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('C++ 资源状态机接口覆盖基础资源转移语义', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'native', 'resource_machine.hpp'), 'utf8');
  for (const symbol of ['take_gold', 'take_cards', 'keep_drawn_card', 'can_end_turn', 'ResourcePending']) {
    assert.match(source, new RegExp(`\\b${symbol}\\b`));
  }
  assert.match(source, /state\.resources_taken/);
  assert.match(source, /state\.hand_count/);
});
