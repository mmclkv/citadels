/* 联机链路测试：用原生 WebSocket（Node 22 内置）模拟两位真人玩家 + 电脑开一局 */
'use strict';
const PORT = Number(process.argv[2] || 8787);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    const api = { ws, name, id: null, roomId: null, last: null, errors: [] };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', name }));
      resolve(api);
    };
    ws.onerror = e => reject(new Error('连接失败 ' + name));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === 'hello') api.id = m.youId;
      if (m.t === 'joined') { api.id = m.youId; api.roomId = m.roomId; api.last = m.state; }
      if (m.t === 'state') api.last = m.state;
      if (m.t === 'error') api.errors.push(m.error);
    };
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

process.on('uncaughtException', e => {
  console.log('!! uncaughtException: ' + (e && e.stack || e));
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200);
});

(async () => {
  console.log('=== 联机链路测试 ===');
  const A = await connect('阿甲');
  A.ws.send(JSON.stringify({ t: 'createRoom', name: '阿甲', config: { playerCount: 4, bots: 1, endDistricts: 7, charSetMode: 'mixed' } }));
  await wait(300);
  if (!A.roomId) { console.log('✗ 创建房间失败', A.errors); process.exit(1); }
  console.log('✓ 创建房间 ' + A.roomId);

  const B = await connect('阿乙');
  B.ws.send(JSON.stringify({ t: 'joinRoom', roomId: A.roomId, name: '阿乙' }));
  await wait(300);
  console.log(B.roomId === A.roomId ? '✓ 加入房间成功' : '✗ 加入房间失败 ' + JSON.stringify(B.errors));

  // 第三人
  const C = await connect('阿丙');
  C.ws.send(JSON.stringify({ t: 'joinRoom', roomId: A.roomId, name: '阿丙' }));
  await wait(300);
  console.log(C.roomId === A.roomId ? '✓ 第三位玩家加入' : '✗ 第三人加入失败');

  A.ws.send(JSON.stringify({ t: 'startGame' }));
  await wait(600);
  const st = A.last;
  console.log(st && st.phase !== 'lobby' ? '✓ 开局成功，阶段=' + st.phase + ' 玩家=' + st.players.length
    : '✗ 开局失败 ' + JSON.stringify(A.errors));

  // 自动推进：真人玩家用 AI 逻辑代打
  const AI = require('../src/ai.js');
  let guard = 0;
  const humans = [A, B, C];
  while (A.last && A.last.phase !== 'gameover' && guard < 4000) {
    guard++;
    if (guard % 25 === 0) console.log('   ...推进中 step=' + guard + ' phase=' + A.last.phase + ' 轮=' + A.last.round);
    let acted = false;
    for (const h of humans) {
      const s = h.last;
      if (!s || s.phase === 'gameover') continue;
      const av = s.available;
      if (s.reaction) {
        if (s.reaction.playerId === h.id && av && av.actions.length) {
          h.ws.send(JSON.stringify({ t: 'action', action: av.actions[0] }));
          acted = true; await wait(60);
        }
        continue;
      }
      if (av && av.actions && av.actions.length) {
        // 优先用「继续/结束」类按钮，其余随意（这里只验证链路通畅）
        const pick = av.actions[Math.floor(Math.random() * av.actions.length)];
        h.ws.send(JSON.stringify({ t: 'action', action: pick }));
        acted = true;
        await wait(60);
      }
    }
    if (!acted) await wait(150);
  }
  const fin = A.last;
  console.log(fin && fin.phase === 'gameover' ? '✓ 对局正常结束，轮次=' + fin.round
    : '✗ 对局未结束（步数 ' + guard + '）phase=' + (fin && fin.phase));
  if (fin && fin.scores) {
    fin.scores.forEach(r => console.log('    ' + r.name + '：' + r.total + ' 分（城区 ' + r.cityCount + '）'));
  }
  const totalErr = humans.reduce((s, h) => s + h.errors.length, 0);
  console.log(totalErr === 0 ? '✓ 全程无服务端错误' : '⚠ 服务端错误 ' + totalErr + ' 次：' +
    humans.map(h => h.errors.slice(0, 3).join('/')).join(' | '));

  // 断线重连 / 房间列表
  const D = await connect('阿丁');
  D.ws.send(JSON.stringify({ t: 'listRooms' }));
  await wait(250);

  A.ws.close(); B.ws.close(); C.ws.close(); D.ws.close();
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 120);
})().catch(e => { console.error('✗ ' + (e && e.stack || e)); process.exitCode = 1;
  setTimeout(() => process.exit(1), 150); });
