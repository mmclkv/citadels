/* =========================================================================
 * 富饶之城 — 联机服务器（零依赖 Node HTTP + WebSocket）
 * 启动：node server.js  [port]
 * ========================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CitCards = require('./src/cards.js');
const CitEngine = require('./src/engine.js');
const CitAI = require('./src/ai.js');

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SRC = path.join(ROOT, 'src');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ------------------------------ 静态资源 ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let file;
  if (urlPath.indexOf('/src/') === 0) file = path.join(SRC, urlPath.slice(5));
  else if (urlPath.indexOf('/images/') === 0) file = path.join(ROOT, urlPath.replace(/^\/+/, ''));
  else file = path.join(PUBLIC, urlPath.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------ 房间管理 ------------------------------ */
const rooms = {};
const clients = new Map();   // ws -> { id, name, roomId }

function genId(pre) {
  return pre + Math.random().toString(36).slice(2, 8);
}
function roomCode() {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += s[Math.floor(Math.random() * s.length)];
  return c;
}

function publicRoom(r) {
  return {
    id: r.id,
    name: r.name,
    phase: r.state ? r.state.phase : 'lobby',
    seats: r.seats.map(s => ({ name: s.name, isBot: !!s.isBot, botLevel: s.botLevel, taken: !!s.taken, id: s.id })),
    config: r.config,
    playerCount: r.seats.length
  };
}

function createRoom(hostName, config) {
  const id = roomCode();
  const seats = [];
  const total = Math.max(2, Math.min(8, config.playerCount || 4));
  const bots = Math.max(0, Math.min(total - 1, config.bots || 0));
  seats.push({ id: genId('p'), name: hostName, isBot: false, taken: true });
  for (let i = 0; i < bots; i++) {
    seats.push({ id: genId('b'), name: '电脑 ' + (i + 1), isBot: true, botLevel: config.botLevel || 'normal', taken: true });
  }
  for (let i = seats.length; i < total; i++) seats.push({ id: null, name: '', isBot: false, taken: false });

  const room = {
    id, name: (hostName || '房主') + ' 的房间',
    seats,     config: {
      playerCount: total,
      endDistricts: config.endDistricts || 8,
      charSetMode: config.charSetMode || 'base',
      botLevel: config.botLevel || 'normal',
      // 房主在开局设置里选的节奏（= 普通动作的间隔毫秒），服务器上的机器人按它减速
      botPace: Number(config.botPace) || 430
    },
    state: null,
    createdAt: Date.now(),
    ticking: false
  };
  rooms[id] = room;
  return room;
}

function joinRoom(roomId, name) {
  const r = rooms[roomId];
  if (!r) return { error: '房间不存在' };
  if (r.state && r.state.phase !== 'gameover') {
    const seat = r.seats.find(s => s.name === name && !s.isBot);
    if (seat) return { room: r, seat, rejoined: true };
    return { error: '该房间已开局' };
  }
  const idx = r.seats.findIndex(s => !s.taken);
  if (idx < 0) return { error: '房间已满' };
  r.seats[idx] = { id: genId('p'), name: name, isBot: false, taken: true };
  return { room: r, seat: r.seats[idx] };
}

function startRoom(r) {
  const seats = r.seats.filter(s => s.taken);
  if (seats.length < 2) return { error: '至少需要 2 位玩家（含电脑）' };
  // 空缺座位自动补电脑
  const filled = seats.slice();
  let bi = 1;
  while (filled.length < Math.max(2, r.config.playerCount)) {
    filled.push({ id: genId('b'), name: '电脑 ' + (bi++), isBot: true, botLevel: r.config.botLevel || 'normal' });
  }
  r.seats = filled.concat(r.seats.filter(s => !s.taken));
  const state = CitEngine.createGame({
    roomId: r.id,
    endDistricts: r.config.endDistricts,
    charSetMode: r.config.charSetMode,
    seats: r.seats.filter(s => s.taken).map(s => ({
      id: s.id, name: s.name, isBot: !!s.isBot, botLevel: s.botLevel
    }))
  });
  r.state = state;
  CitEngine.startGame(state);
  return { ok: true };
}

function broadcast(r) {
  const msg = JSON.stringify({ t: 'state', state: viewFor(r, null) });
  r.seats.forEach(s => { if (s.id) sendTo(s.id, msg); });
}
function sendTo(playerId, msg) {
  clients.forEach((c, ws) => {
    if (c.id === playerId) wsSend(ws, msg);
  });
}
function viewFor(r, playerId) {
  if (!r.state) return lobbyView(r);
  const base = CitEngine.sanitize(r.state, playerId);
  base.roomId = r.id;
  base.roomName = r.name;
  base.players.forEach(p => {
    const s = r.seats.find(x => x.id === p.id);
    p.connected = s ? true : false;
  });
  base.available = playerId ? CitEngine.getAvailableActions(r.state, playerId) : null;
  return base;
}
function sendPersonal(r) {
  r.seats.forEach(s => {
    if (!s.id) return;
    const payload = JSON.stringify({ t: 'state', state: viewFor(r, s.id) });
    sendTo(s.id, payload);
  });
}

/* ------------------------------ 电脑驱动 ------------------------------ */
// 服务器上的机器人按房主设定的 botPace（普通动作间隔）放慢性子，
// 再按动作类型做档位缩放，和客户端本地的 PACE 保持一致的手感。
function botDelayFor(r, action) {
  const base = (r.config && r.config.botPace) || 430;   // 普通动作间隔（= PACE.act）
  if (!action) return Math.round(base * 0.5);
  switch (action.type) {
    case 'draft_pick':
    case 'draft_discard':
      return Math.round(base * 1.3);                    // 选牌较慢，给真人留观察时间
    case 'choose_char':
    case 'build':
    case 'warlord_destroy':
    case 'marshal_seize':
    case 'choose_district':
    case 'choose_player':
    case 'choose_cards':
      return Math.round(base * 1.6);                    // 刺杀/建造/摧毁这类大动作更慢
    case 'income':
    case 'take_gold':
    case 'take_cards':
    case 'ability':
    case 'end_turn':
    case 'ability_skip':
      return base;
    default:
      return Math.round(base * 0.5);
  }
}

function currentActor(state) {
  if (state.phase === 'draft' && state.draft) {
    const step = state.draft.steps[state.draft.stepIdx];
    if (step) return state.players[step.player];
    return null;
  }
  if (state.reaction) return state.players[state.reaction.playerIdx];
  // 轮末确认：找第一个还没确认的玩家
  if (state.roundConfirm) {
    const i = (state.roundConfirm.confirmed || []).findIndex(c => !c);
    return i >= 0 ? state.players[i] : null;
  }
  if (state.turn) return state.players[state.turn.playerIdx];
  return null;
}

function botTick(r) {
  if (r.ticking) return;
  r.ticking = true;
  const step = () => {
    const st = r.state;
    if (!st || st.phase === 'gameover') { r.ticking = false; sendPersonal(r); return; }
    const actor = currentActor(st);
    if (!actor || !actor.isBot) { r.ticking = false; sendPersonal(r); return; }
    let action = null;
    try { action = CitAI.decide(st, actor.id); } catch (e) { console.error('AI error', e); }
    if (!action) { r.ticking = false; sendPersonal(r); return; }
    let res = CitEngine.applyAction(st, actor.id, action);
    if (!res.ok) {
      if (st.phase === 'draft') {
        // 选角失败时从合法行动中挑第一个再试一次，避免空转卡死
        const opts = CitEngine.getAvailableActions(st, actor.id);
        if (opts && opts.length) {
          res = CitEngine.applyAction(st, actor.id, opts[0]);
        }
      }
      if (!res.ok) {
        // 兜底：跳过能力 / 结束回合
        if (st.turn && st.turn.pending) CitEngine.applyAction(st, actor.id, { type: 'ability_skip' });
        else if (st.turn) CitEngine.applyAction(st, actor.id, { type: 'end_turn' });
        console.warn('bot fallback:', res.error);
      }
    }
    sendPersonal(r);
    setTimeout(step, botDelayFor(r, action));
  };
  setTimeout(step, (r.config && r.config.botPace) || 430);
}

function afterChange(r) {
  sendPersonal(r);
  botTick(r);
}

/* ------------------------------ WebSocket ------------------------------ */
function wsSend(ws, str) {
  if (!ws || ws.destroyed || ws.readyState !== 'open') return;
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2); head[0] = 0x81; head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127;
    head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6);
  }
  try { ws.write(Buffer.concat([head, payload])); } catch (e) { /* ignore */ }
}

function wsParse(buf) {
  // 返回 { messages: [str], rest: Buffer }
  const out = [];
  let rest = buf;
  while (true) {
    if (rest.length < 2) break;
    const b0 = rest[0], b1 = rest[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0F;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7F;
    let off = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (rest.length < 10) break;
      len = rest.readUInt32BE(6); off = 10;
    }
    let mask = null;
    if (masked) {
      if (rest.length < off + 4) break;
      mask = rest.slice(off, off + 4); off += 4;
    }
    if (rest.length < off + len) break;
    let data = rest.slice(off, off + len);
    if (mask) {
      const d = Buffer.alloc(len);
      for (let i = 0; i < len; i++) d[i] = data[i] ^ mask[i % 4];
      data = d;
    }
    rest = rest.slice(off + len);
    if (opcode === 0x8) return { messages: out, rest: Buffer.alloc(0), close: true };
    if (opcode === 0x9) { continue; }
    if (opcode === 0x1 || opcode === 0x2) out.push(data.toString('utf8'));
    if (!fin) break;
  }
  return { messages: out, rest: rest };
}

/* ------------------------------ 消息处理 ------------------------------ */
function handle(ws, info, msg) {
  switch (msg.t) {
    case 'hello':
      info.id = info.id || genId('p');
      info.name = msg.name || '玩家';
      wsSend(ws, JSON.stringify({ t: 'hello', youId: info.id }));
      wsSend(ws, JSON.stringify({ t: 'rooms', rooms: Object.values(rooms).map(publicRoom) }));
      break;

    case 'listRooms':
      wsSend(ws, JSON.stringify({ t: 'rooms', rooms: Object.values(rooms).map(publicRoom) }));
      break;

    case 'createRoom': {
      const r = createRoom(msg.name || info.name || '房主', msg.config || {});
      info.roomId = r.id;
      info.id = r.seats[0].id;
      info.name = r.seats[0].name;
      wsSend(ws, JSON.stringify({ t: 'joined', roomId: r.id, youId: info.id, state: lobbyView(r) }));
      sendPersonal(r);
      break;
    }

    case 'joinRoom': {
      const res = joinRoom(msg.roomId, msg.name || info.name || '玩家');
      if (res.error) { wsSend(ws, JSON.stringify({ t: 'error', error: res.error })); break; }
      const r = res.room;
      info.roomId = r.id;
      info.id = res.seat.id;
      info.name = res.seat.name;
      wsSend(ws, JSON.stringify({ t: 'joined', roomId: r.id, youId: info.id, state: lobbyView(r) }));
      sendPersonal(r);
      break;
    }

    case 'leaveRoom': {
      const r = rooms[info.roomId];
      if (r) {
        const s = r.seats.find(x => x.id === info.id);
        if (s && !r.state) { s.taken = false; s.name = ''; s.id = null; }
        sendPersonal(r);
        if (r.seats.every(x => !x.taken) && !r.state) delete rooms[r.id];
      }
      info.roomId = null;
      wsSend(ws, JSON.stringify({ t: 'rooms', rooms: Object.values(rooms).map(publicRoom) }));
      break;
    }

    case 'config': {
      const r = rooms[info.roomId];
      if (!r || r.state) { wsSend(ws, JSON.stringify({ t: 'error', error: '无法修改' })); break; }
      if (msg.config) {
        if (msg.config.endDistricts) r.config.endDistricts = msg.config.endDistricts;
        if (msg.config.charSetMode) r.config.charSetMode = msg.config.charSetMode;
        if (msg.config.botLevel) r.config.botLevel = msg.config.botLevel;
        if (msg.config.botPace) r.config.botPace = Number(msg.config.botPace) || r.config.botPace;
        if (msg.config.playerCount) {
          const t = Math.max(2, Math.min(8, msg.config.playerCount));
          r.config.playerCount = t;
          while (r.seats.length < t) r.seats.push({ id: null, name: '', isBot: false, taken: false });
          while (r.seats.length > t && r.seats[r.seats.length - 1].taken === false) r.seats.pop();
        }
      }
      sendPersonal(r);
      break;
    }

    case 'setSeat': {
      const r = rooms[info.roomId];
      if (!r || r.state) { wsSend(ws, JSON.stringify({ t: 'error', error: '无法修改' })); break; }
      const i = msg.index;
      if (i == null || i < 0 || i >= r.seats.length) break;
      if (i === 0) break;
      const s = r.seats[i];
      if (msg.kind === 'bot') {
        r.seats[i] = { id: genId('b'), name: '电脑 ' + i, isBot: true, botLevel: r.config.botLevel || 'normal', taken: true };
      } else if (msg.kind === 'open') {
        r.seats[i] = { id: null, name: '', isBot: false, taken: false };
      }
      sendPersonal(r);
      break;
    }

    case 'startGame': {
      const r = rooms[info.roomId];
      if (!r) break;
      const res = startRoom(r);
      if (res.error) { wsSend(ws, JSON.stringify({ t: 'error', error: res.error })); break; }
      afterChange(r);
      break;
    }

    case 'action': {
      const r = rooms[info.roomId];
      if (!r || !r.state) { wsSend(ws, JSON.stringify({ t: 'error', error: '尚未开局' })); break; }
      const res = CitEngine.applyAction(r.state, info.id, msg.action);
      if (!res.ok) { wsSend(ws, JSON.stringify({ t: 'error', error: res.error })); break; }
      afterChange(r);
      break;
    }

    case 'setPace': {
      const r = rooms[info.roomId];
      if (!r) break;
      // 在线模式下，所有机器人跑在服务器上；这个节奏由当前玩家实时调节
      const v = Number(msg.pace);
      if (v && v >= 60 && v <= 6000) r.config.botPace = Math.round(v);
      break;
    }

    case 'restart': {
      const r = rooms[info.roomId];
      if (!r) break;
      r.state = null;
      sendPersonal(r);
      break;
    }

    case 'chat': {
      const r = rooms[info.roomId];
      if (!r) break;
      const m = JSON.stringify({ t: 'chat', from: info.name || '?', text: String(msg.text || '').slice(0, 200) });
      r.seats.forEach(s => { if (s.id) sendTo(s.id, m); });
      break;
    }
  }
}

function lobbyView(r) {
  return {
    roomId: r.id, roomName: r.name, phase: 'lobby',
    you: null,
    seats: r.seats.map((s, i) => ({ index: i, id: s.id, name: s.name, isBot: !!s.isBot, taken: !!s.taken })),
    config: r.config
  };
}

/* ------------------------------ HTTP 服务 ------------------------------ */
const server = http.createServer((req, res) => {
  if (req.url === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ rooms: Object.values(rooms).map(publicRoom) }));
  }
  return serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  const info = { id: null, name: '玩家', roomId: null };
  clients.set(socket, info);
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const r = wsParse(buf);
    buf = r.rest;
    r.messages.forEach(str => {
      let msg;
      try { msg = JSON.parse(str); } catch (e) { return; }
      try { handle(socket, info, msg); } catch (e) { console.error('handle error', e); }
    });
    if (r.close) {
      onClose(socket, info);
    }
  });
  socket.on('error', () => onClose(socket, info));
  socket.on('close', () => onClose(socket, info));
});

function onClose(socket, info) {
  if (!clients.has(socket)) return;
  clients.delete(socket);
  if (info.roomId) {
    const r = rooms[info.roomId];
    if (r) {
      const s = r.seats.find(x => x.id === info.id);
      if (s) {
        // 断线后自动由电脑托管
        s.isBot = true;
        s.botLevel = 'normal';
        if (r.state && r.state.phase !== 'gameover') {
          const ps = r.state.players.find(p => p.id === s.id);
          if (ps) ps.isBot = true;
          CitEngine.log(r.state, s.name + ' 已断线，由电脑托管。', 'sys');
          botTick(r);
        }
      }
      sendPersonal(r);
    }
  }
}

server.listen(PORT, () => {
  console.log('');
  console.log('  富饶之城 / 荣耀之城 (Citadels) 联机服务器已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log('  本机访问：  http://localhost:' + PORT);
  const nets = [];
  const os = require('os');
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(k => ifaces[k].forEach(i => {
    if (i.family === 'IPv4' && !i.internal) nets.push(i.address);
  }));
  nets.forEach(a => console.log('  局域网访问：http://' + a + ':' + PORT));
  console.log('');
});
