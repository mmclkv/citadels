'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const neon = fs.readFileSync(path.join(root, 'public', 'themes', 'neon', 'theme.css'), 'utf8');

test('霓虹主题覆盖运行时控件与剩余经典色组件', () => {
  for (const selector of [
    'chat-composer',
    'player-chat-bubble.self',
    'draft-head h3',
    'rs-tag',
    'rc-who',
    'rc-btn',
    'mobile-menu-toggle',
    'fly-card',
    'building-build-flight',
    'event-box.tone-warn .event-title',
    '::-webkit-scrollbar-thumb'
  ]) {
    assert.ok(neon.includes(selector), `缺少霓虹样式：${selector}`);
  }
  assert.match(neon, /--paper2\s*:/);
  assert.match(neon, /--gold-d\s*:/);
});
