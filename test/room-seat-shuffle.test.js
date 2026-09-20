'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, connect, until } = require('./agent-harness');

test('房主可以在开局前打乱非房主座位，房主座位保持不变', async t => {
  const f = await fixture(false); t.after(f.close);
  const host = await connect(f.base, '房主');
  const guests = await Promise.all(['玩家2', '玩家3', '玩家4'].map(name => connect(f.base, name)));
  t.after(host.close);
  guests.forEach(client => t.after(client.close));

  host.send({ t: 'createRoom', name: '房主', config: { playerCount: 4, bots: 0 } });
  await until(() => host.state && host.state.phase === 'lobby', 'room creation');
  for (const [i, guest] of guests.entries()) {
    guest.send({ t: 'joinRoom', roomId: host.state.roomId, name: '玩家' + (i + 2) });
    await until(() => guest.state && guest.state.phase === 'lobby', 'guest join');
  }
  await until(() => host.state && host.state.seats.every(seat => seat.taken), 'all seats filled');

  const before = host.state.seats.map(seat => seat.id);
  assert.equal(before[0], host.id, '房主应在 1 号座位');
  let changed = false;
  for (let i = 0; i < 8 && !changed; i++) {
    host.send({ t: 'shuffleSeats' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const current = host.state.seats.map(seat => seat.id);
    changed = current.some((id, index) => id !== before[index]);
  }
  assert.equal(host.state.seats[0].id, host.id);
  assert.deepEqual(host.state.seats.map(seat => seat.id).sort(), before.slice().sort());
  assert.equal(changed, true, '多次打乱后非房主座位应发生变化');
});

test('座位打乱按钮只在房间大厅显示且由房主控制', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(html, /id="btn-net-shuffle"[^>]*>打乱座位<\/button>/);
  assert.match(app, /\$\('#btn-net-shuffle'\)\.style\.display = amHost \? '' : 'none'/);
  assert.match(app, /Net\.send\(\{ t: 'shuffleSeats' \}\)/);
});
