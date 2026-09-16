'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('右侧边栏在顶部提供收起/展开按钮', () => {
  assert.match(html, /<aside class="side-panel" id="side-panel">[\s\S]*<div class="side-panel-head">/);
  assert.match(html, /id="btn-side-panel-toggle"[^>]*aria-controls="side-panel-body"/);
  assert.match(html, /id="side-panel-body"/);
  assert.match(html, /<div class="side-panel-head">[\s\S]*<div class="side-tabs" id="side-tabs">/);
  assert.match(html, /<div class="side-tabs" id="side-tabs">[\s\S]*<\/div>\s*<button class="side-panel-toggle"/);
  assert.doesNotMatch(html, /<div class="side-tabs" id="side-tabs" hidden>/);
  assert.doesNotMatch(html, /<div class="side-pane" id="pane-log">\s*<h3>/);
  assert.doesNotMatch(html, /<div class="side-pane" id="pane-chat" hidden>\s*<h3>/);
  assert.doesNotMatch(html, /side-panel-toggle-label/);
  assert.match(app, /sidePanelCollapsed: false/);
  assert.match(app, /sp\.classList\.toggle\('collapsed', collapsed\)/);
  assert.match(app, /sidePanelToggle\.onclick = \(\) =>/);
  assert.match(css, /\.side-panel\.collapsed \.side-panel-body\{display:none\}/);
});

test('Enter 呼出联机发言框，发言框有明确关闭入口', () => {
  assert.match(html, /id="chat-close"[^>]*aria-label="关闭发言框"/);
  assert.match(app, /e\.key === 'Enter'[\s\S]*?openChatComposer\(\);/);
  assert.match(app, /!interactive[\s\S]*App\.mode === 'net'/);
  assert.match(app, /\$\('#chat-close'\)\.onclick = closeChatComposer;/);
  assert.match(app, /if \(!text\) \{ closeChatComposer\(\); return; \}/);
});

test('霓虹主题输入框只保留柔和的主题色发光焦点', () => {
  const neon = fs.readFileSync(path.join(root, 'public', 'themes', 'neon', 'theme.css'), 'utf8');
  assert.match(neon, /input:focus-visible,[\s\S]*?select:focus-visible \{ outline:none; \}/);
  assert.match(neon, /input:focus,[\s\S]*?box-shadow:0 0 0 3px rgba\(67,228,255,\.14\),0 0 14px rgba\(67,228,255,\.30\)/);
});
