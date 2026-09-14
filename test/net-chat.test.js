'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, connect, until } = require('./agent-harness');

test('multiplayer chat identifies the speaker and broadcasts sanitized text in game', async t => {
  const f = await fixture();
  t.after(f.close);
  const host = await connect(f.base, '房主');
  const guest = await connect(f.base, '访客');
  t.after(host.close);
  t.after(guest.close);

  host.send({ t: 'createRoom', name: '房主', config: { playerCount: 2, bots: 0 } });
  await until(() => host.state && host.state.roomId, 'room creation');
  guest.send({ t: 'joinRoom', roomId: host.state.roomId, name: '访客' });
  await until(() => guest.id && guest.state && guest.state.roomId === host.state.roomId, 'guest join');
  host.send({ t: 'startGame' });
  await until(() => host.state && host.state.phase !== 'lobby', 'game start');

  const before = guest.messages.length;
  host.send({ t: 'chat', text: '  <b>你好</b>\n  联机玩家  ' });
  const chat = await until(
    () => guest.messages.slice(before).find(m => m.t === 'chat'),
    'chat broadcast'
  );

  assert.equal(chat.playerId, host.id);
  assert.equal(chat.playerName, '房主');
  assert.equal(chat.text, '<b>你好</b> 联机玩家');
  assert.equal(typeof chat.sentAt, 'number');
});

test('chat UI uses text nodes and includes the collapsible composer controls', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  assert.match(html, /id="btn-chat"[^>]*>发言<\/button>/);
  assert.match(html, /id="chat-input"[^>]*maxlength="120"/);
  assert.match(html, /id="chat-send"[^>]*>发送<\/button>/);
  assert.match(app, /textNode\.textContent = String\(message\.text\)/);
  assert.match(app, /Net\.send\(\{ t: 'chat', text: text \}\);\s*closeChatComposer\(\);/);
});

test('chat history sidebar: toggle, tabbed panes, and self-bubble are wired', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  // 菜单里的「聊天记录」开关
  assert.match(html, /id="btn-chat-log-toggle"[^>]*>\s*聊天记录\s*<\/button>/);
  // 侧栏改为可切换的标签页结构（战报 / 聊天记录叠加）
  assert.match(html, /id="side-tabs"[^>]*>/);
  assert.match(html, /id="tab-log"[^>]*>战报<\/button>/);
  assert.match(html, /id="tab-chat"[^>]*>聊天记录<\/button>/);
  assert.match(html, /id="pane-log"[^>]*>/);
  assert.match(html, /id="pane-chat"[^>]*>/);
  assert.match(html, /id="chat-log"[^>]*>/);
  // 开关与切页逻辑
  assert.match(app, /function updateSidePanel\(\)/);
  assert.match(app, /App\.chatOpen = !App\.chatOpen/);
  assert.match(app, /\$\('#tab-log'\)\.onclick/);
  assert.match(app, /\$\('#tab-chat'\)\.onclick/);
  // 聊天记录被收集并在打开时渲染
  assert.match(app, /App\.chatHistory\.push\(/);
  assert.match(app, /function renderChatLog\(\)/);
  // 自己发言也在自己圆角矩形头顶弹出气泡（不再用 !== App.myId 过滤）
  assert.match(app, /if \(m\.playerId\) showPlayerChatBubble\(m\)/);
  assert.match(app, /bubble\.classList\.add\('self'\)/);
});
