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
