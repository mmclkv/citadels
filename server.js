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
const AgentModule = require('./src/agent.js');
const CodexGatewayModule = require('./lib/codex-agent-gateway.js');
const TrainingManagerModule = require('./lib/training-manager.js');
const LocalNeuralBotModule = require('./lib/local-neural-bot.js');

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SRC = path.join(ROOT, 'src');
const trainingManager = TrainingManagerModule.createTrainingManager({ root: ROOT });
const localNeuralBot = LocalNeuralBotModule.createLocalNeuralBot({ root: ROOT });
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 20000;

// With no external model configuration, use the Codex account already signed in
// on this computer. The compatibility endpoint is loopback-only and lives on the
// same HTTP server, so no account token is exposed to browser clients.
const externalAgentRequested = !!(
  process.env.CITADELS_AGENT_BASE_URL ||
  process.env.CITADELS_AGENT_MODEL ||
  process.env.CITADELS_AGENT_API_KEY
);
const localCodex = CodexGatewayModule.detectCodex();
const useLocalCodex = !externalAgentRequested &&
  process.env.CITADELS_DISABLE_LOCAL_CODEX !== '1' && localCodex.available;
const localCodexGateway = useLocalCodex ? CodexGatewayModule.createCodexAgentGateway() : null;
const agentEnv = useLocalCodex ? {
  ...process.env,
  CITADELS_AGENT_BASE_URL: 'http://127.0.0.1:' + PORT + '/api/codex/v1',
  CITADELS_AGENT_MODEL: localCodexGateway.modelName,
  CITADELS_AGENT_API_KEY: '',
  CITADELS_AGENT_TIMEOUT_MS: process.env.CITADELS_AGENT_TIMEOUT_MS || '150000'
} : process.env;
const CitAgent = AgentModule.createAgent({ config: AgentModule.configFromEnv(agentEnv) });

function agentStatus() {
  const status = CitAgent.status();
  if (useLocalCodex) return {
    ...status,
    provider: 'local-codex',
    version: localCodex.version,
    message: '已连接本机 Codex（复用当前电脑保存的登录）'
  };
  if (!externalAgentRequested && !localCodex.available) return {
    ...status,
    provider: 'none',
    message: '未找到 Codex CLI；请先安装并登录 Codex，或配置外部模型服务'
  };
  return { ...status, provider: 'external' };
}

const AgentBackend = {
  status: agentStatus,
  decide: (...args) => CitAgent.decide(...args)
};

function normalizeBotType(value) {
  return value === 'agent' || value === 'neural' ? value : 'npc';
}

function botTypeError(type) {
  if (type === 'agent' && !agentStatus().configured) return agentStatus().message;
  if (type === 'neural' && !localNeuralBot.status().configured) return localNeuralBot.status().message;
  return '';
}

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
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('bad path'); }
  if (urlPath === '/') urlPath = '/index.html';
  let base = PUBLIC, relative = urlPath.replace(/^\/+/, '');
  if (urlPath.indexOf('/src/') === 0) { base = SRC; relative = urlPath.slice(5); }
  else if (urlPath.indexOf('/images/') === 0) { base = path.join(ROOT, 'images'); relative = urlPath.slice(8); }
  const file = path.resolve(base, relative);
  const check = path.relative(base, file);
  // Keep server code, environment files and Git data outside every static mount.
  if (check.startsWith('..') || path.isAbsolute(check) || relative.split(/[\\/]/).some(p => p.startsWith('.'))) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------ 房间管理 ------------------------------ */
const rooms = {};
const clients = new Map();   // ws -> { id, name, roomId, lastSeenAt }

function genId(pre) {
  return pre + Math.random().toString(36).slice(2, 8);
}
function genResumeToken() {
  return crypto.randomBytes(24).toString('hex');
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
    seats: r.seats.map(s => ({ name: s.name, isBot: !!s.isBot, botType: s.botType || 'npc', botLevel: s.botLevel, taken: !!s.taken,
      id: s.id, connected: !!s.isBot || !s.disconnected && !s.left, disconnected: !!s.disconnected, left: !!s.left })),
    config: r.config,
    playerCount: r.seats.length
  };
}

function createRoom(hostName, config) {
  const id = roomCode();
  const seats = [];
  const total = Math.max(2, Math.min(8, config.playerCount || 4));
  const bots = Math.max(0, Math.min(total - 1, config.bots || 0));
  seats.push({ id: genId('p'), name: hostName, resumeToken: genResumeToken(), isBot: false, taken: true,
    disconnected: false, left: false });
  for (let i = 0; i < bots; i++) {
    seats.push({ id: genId('b'), name: '电脑 ' + (i + 1), isBot: true, botType: normalizeBotType(config.botType), botLevel: config.botLevel || 'normal', taken: true });
  }
  for (let i = seats.length; i < total; i++) seats.push({ id: null, name: '', isBot: false, taken: false,
    disconnected: false, left: false });

  const room = {
    id, name: (hostName || '房主') + ' 的房间',
    seats,     config: {
      playerCount: total,
      endDistricts: config.endDistricts || 8,
      charSetMode: config.charSetMode || 'base',
      botLevel: config.botLevel || 'normal',
      botType: normalizeBotType(config.botType),
      // 房主在开局设置里选的节奏（= 普通动作的间隔毫秒），服务器上的机器人按它减速
      botPace: Number(config.botPace) || 430
    },
    state: null,
    createdAt: Date.now(),
    botJob: null,
    closed: false
  };
  rooms[id] = room;
  return room;
}

function joinRoom(roomId, name) {
  const r = rooms[roomId];
  if (!r) return { error: '房间不存在' };
  if (r.state && r.state.phase !== 'gameover') {
    const seat = r.seats.find(s => s.name === name && !s.isBot && !s.left);
    if (seat) return { room: r, seat, rejoined: true };
    return { error: '该房间已开局' };
  }
  const idx = r.seats.findIndex(s => !s.taken);
  if (idx < 0) return { error: '房间已满' };
  r.seats[idx] = { id: genId('p'), name: name, resumeToken: genResumeToken(), isBot: false, taken: true,
    disconnected: false, left: false };
  return { room: r, seat: r.seats[idx] };
}

function resumeRoom(token, roomId) {
  if (!token) return null;
  const list = roomId && rooms[roomId] ? [rooms[roomId]] : Object.values(rooms);
  for (const r of list) {
    const seat = r.seats.find(s => s.taken && s.resumeToken === token);
    if (seat) return { room: r, seat: seat };
  }
  return null;
}

function restoreSeat(r, seat) {
  seat.isBot = false;
  seat.disconnected = false;
  seat.left = false;
  if (!r.state) return;
  const player = r.state.players.find(p => p.id === seat.id);
  if (player) player.isBot = false;
}

function startRoom(r) {
  if (r.state) return { error: '该房间已开局' };
  const seats = r.seats.filter(s => s.taken);
  if (!seats.length) return { error: '房间没有玩家' };
  const usesAgent = seats.some(s => s.isBot && s.botType === 'agent') ||
    (seats.length < r.config.playerCount && r.config.botType === 'agent');
  if (usesAgent && !agentStatus().configured) return { error: agentStatus().message };
  const usesNeural = seats.some(s => s.isBot && s.botType === 'neural') ||
    (seats.length < r.config.playerCount && r.config.botType === 'neural');
  if (usesNeural && !localNeuralBot.status().configured) return { error: localNeuralBot.status().message };
  // 空缺座位自动补电脑
  const filled = seats.slice();
  let bi = 1;
  while (filled.length < Math.max(2, r.config.playerCount)) {
    filled.push({ id: genId('b'), name: '电脑 ' + (bi++), taken: true, isBot: true, botType: r.config.botType || 'npc', botLevel: r.config.botLevel || 'normal' });
  }
  r.seats = filled;
  const state = CitEngine.createGame({
    roomId: r.id,
    endDistricts: r.config.endDistricts,
    charSetMode: r.config.charSetMode,
    seats: r.seats.filter(s => s.taken).map(s => ({
      id: s.id, name: s.name, isBot: !!s.isBot, botType: s.botType || 'npc', botLevel: s.botLevel
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
  base.hostId = r.seats[0] && r.seats[0].id;
  base.agentStatus = r.agentStatus || null;
  base.players.forEach(p => {
    const seat = r.seats.find(s => s.id === p.id);
    const client = Array.from(clients.values()).find(c => c.id === p.id && c.roomId === r.id);
    const connected = !!client && Date.now() - client.lastSeenAt <= HEARTBEAT_TIMEOUT_MS;
    p.connected = connected || !!(seat && seat.isBot);
    p.disconnected = !!(seat && seat.disconnected);
    p.left = !!(seat && seat.left);
    // 断连/离开的真人仍由服务端托管，但界面应显示“已断连/已离开”，而不是误显示为电脑。
    if (p.disconnected || p.left) p.isBot = false;
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
function sendPersonalExcept(r, excludedId) {
  r.seats.forEach(s => {
    if (!s.id || s.id === excludedId) return;
    const payload = JSON.stringify({ t: 'state', state: viewFor(r, s.id) });
    sendTo(s.id, payload);
  });
}

function sendRoomNotice(r, notice, excludedId) {
  const msg = JSON.stringify({ t: 'roomNotice', notice });
  r.seats.forEach(s => { if (s.id && s.id !== excludedId) sendTo(s.id, msg); });
}

function hasRemainingHuman(r) {
  return r.seats.some(s => s.taken && !s.isBot && !s.left);
}

function closeRoomIfEmpty(r) {
  if (!r || hasRemainingHuman(r)) return false;
  r.closed = true;
  botDriver.cancel(r);
  if (rooms[r.id] === r) delete rooms[r.id];
  return true;
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

const botDriver = require('./lib/bot-driver.js').createBotDriver({
  Engine: CitEngine, AI: CitAI, agent: AgentBackend, neural: localNeuralBot, currentActor,
  send: sendPersonal, delay: botDelayFor
});
function botTick(r) { botDriver.tick(r); }

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
      const resumed = resumeRoom(msg.resumeToken, msg.roomId);
      if (resumed) {
        restoreSeat(resumed.room, resumed.seat);
        info.id = resumed.seat.id;
        info.name = resumed.seat.name;
        info.roomId = resumed.room.id;
      }
      wsSend(ws, JSON.stringify({ t: 'hello', youId: info.id, resumed: !!resumed }));
      if (resumed) {
        const state = resumed.room.state ? viewFor(resumed.room, info.id) : lobbyView(resumed.room);
        wsSend(ws, JSON.stringify({ t: 'joined', roomId: resumed.room.id, youId: info.id,
          resumeToken: resumed.seat.resumeToken, state: state }));
        sendPersonal(resumed.room);
      } else {
        wsSend(ws, JSON.stringify({ t: 'rooms', rooms: Object.values(rooms).map(publicRoom) }));
      }
      break;

    case 'heartbeat':
      wsSend(ws, JSON.stringify({ t: 'heartbeat', ts: msg.ts || Date.now() }));
      break;

    case 'listRooms':
      wsSend(ws, JSON.stringify({ t: 'rooms', rooms: Object.values(rooms).map(publicRoom) }));
      break;

    case 'createRoom': {
      const backendError = botTypeError(msg.config && msg.config.botType);
      if (backendError) {
        wsSend(ws, JSON.stringify({ t: 'error', error: backendError })); break;
      }
      const r = createRoom(msg.name || info.name || '房主', msg.config || {});
      info.roomId = r.id;
      info.id = r.seats[0].id;
      info.name = r.seats[0].name;
      wsSend(ws, JSON.stringify({ t: 'joined', roomId: r.id, youId: info.id,
        resumeToken: r.seats[0].resumeToken, state: lobbyView(r) }));
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
      wsSend(ws, JSON.stringify({ t: 'joined', roomId: r.id, youId: info.id,
        resumeToken: res.seat.resumeToken, state: lobbyView(r) }));
      sendPersonal(r);
      break;
    }

    case 'leaveRoom': {
      const r = rooms[info.roomId];
      if (r) {
        const s = r.seats.find(x => x.id === info.id);
        if (s && !r.state) {
          const leavingName = s.name;
          s.taken = false; s.name = ''; s.id = null; s.disconnected = false; s.left = false;
          sendRoomNotice(r, { kind: 'player_left', playerName: leavingName }, info.id);
          sendPersonalExcept(r, info.id);
          if (r.seats.every(x => !x.taken)) closeRoomIfEmpty(r);
        } else if (s && r.state) {
          s.left = true;
          s.disconnected = false;
          const ps = r.state.players.find(p => p.id === s.id);
          if (ps && r.state.phase !== 'gameover') ps.isBot = true;
          if (r.state.phase !== 'gameover') CitEngine.log(r.state, s.name + ' 已离开对局，由电脑托管。', 'sys');
          sendRoomNotice(r, { kind: 'player_left', playerId: s.id, playerName: s.name }, info.id);
          sendPersonalExcept(r, info.id);
          if (!closeRoomIfEmpty(r)) botTick(r);
        }
      }
      info.roomId = null;
      wsSend(ws, JSON.stringify({ t: 'rooms', rooms: Object.values(rooms).map(publicRoom) }));
      break;
    }

    case 'config': {
      const r = rooms[info.roomId];
      if (!r || r.state) { wsSend(ws, JSON.stringify({ t: 'error', error: '无法修改' })); break; }
      if (r.seats[0].id !== info.id) { wsSend(ws, JSON.stringify({ t: 'error', error: '仅房主可修改配置' })); break; }
      if (msg.config) {
        if (msg.config.endDistricts) r.config.endDistricts = msg.config.endDistricts;
        if (msg.config.charSetMode) r.config.charSetMode = msg.config.charSetMode;
        if (msg.config.botLevel) r.config.botLevel = msg.config.botLevel;
        if (msg.config.botPace) r.config.botPace = Number(msg.config.botPace) || r.config.botPace;
        if (msg.config.playerCount) {
          const t = Math.max(2, Math.min(8, msg.config.playerCount));
          r.config.playerCount = t;
          while (r.seats.length < t) r.seats.push({ id: null, name: '', isBot: false, taken: false,
            disconnected: false, left: false });
          while (r.seats.length > t && r.seats[r.seats.length - 1].taken === false) r.seats.pop();
        }
      }
      sendPersonal(r);
      break;
    }

    case 'setSeat': {
      const r = rooms[info.roomId];
      if (!r || r.state) { wsSend(ws, JSON.stringify({ t: 'error', error: '无法修改' })); break; }
      if (r.seats[0].id !== info.id) { wsSend(ws, JSON.stringify({ t: 'error', error: '仅房主可修改座位' })); break; }
      const i = msg.index;
      if (i == null || i < 0 || i >= r.seats.length) break;
      if (i === 0) break;
      const s = r.seats[i];
      if (msg.kind === 'bot') {
        const botType = msg.botType ? normalizeBotType(msg.botType) : r.config.botType;
        const backendError = botTypeError(botType);
        if (backendError) {
          wsSend(ws, JSON.stringify({ t: 'error', error: backendError })); break;
        }
        r.seats[i] = { id: s.isBot ? s.id : genId('b'), name: '电脑 ' + i, isBot: true, botType, botLevel: r.config.botLevel || 'normal', taken: true,
          disconnected: false, left: false };
      } else if (msg.kind === 'open') {
        r.seats[i] = { id: null, name: '', isBot: false, taken: false };
      }
      sendPersonal(r);
      break;
    }

    case 'startGame': {
      const r = rooms[info.roomId];
      if (!r) break;
      if (r.seats[0].id !== info.id) { wsSend(ws, JSON.stringify({ t: 'error', error: '仅房主可开始游戏' })); break; }
      const res = startRoom(r);
      if (res.error) { wsSend(ws, JSON.stringify({ t: 'error', error: res.error })); break; }
      afterChange(r);
      break;
    }

    case 'agentControl': {
      const r = rooms[info.roomId];
      if (!r || !r.state || r.seats[0].id !== info.id) {
        wsSend(ws, JSON.stringify({ t: 'error', error: '仅房主可控制 Agent' })); break;
      }
      if (!r.agentStatus || r.agentStatus.state !== 'error') break;
      const actor = currentActor(r.state);
      if (!actor || actor.id !== r.agentStatus.playerId || !actor.isBot) break;
      if (!['retry', 'npc'].includes(msg.mode)) break;
      botDriver.cancel(r);
      if (msg.mode === 'npc') {
        actor.botType = 'npc';
        const seat = r.seats.find(s => s.id === actor.id);
        if (seat) seat.botType = 'npc';
        CitEngine.log(r.state, actor.name + ' 已由房主切换为普通电脑。', 'sys');
      }
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
      if (r.seats[0].id !== info.id) { wsSend(ws, JSON.stringify({ t: 'error', error: '仅房主可重开游戏' })); break; }
      botDriver.cancel(r);
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
    seats: r.seats.map((s, i) => ({ index: i, id: s.id, name: s.name, isBot: !!s.isBot,
      botType: s.botType || 'npc', taken: !!s.taken,
      connected: !!s.isBot || !s.disconnected && !s.left, disconnected: !!s.disconnected, left: !!s.left })),
    config: r.config
  };
}

/* ------------------------------ HTTP 服务 ------------------------------ */
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求内容过大')); req.destroy(); return; }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(new Error('请求不是有效 JSON')); }
    });
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const server = http.createServer(async (req, res) => {
  if (localCodexGateway && await localCodexGateway.handle(req, res)) return;
  const pathname = req.url.split('?')[0];
  if (pathname === '/api/training/status' && req.method === 'GET') {
    const payload = trainingManager.status();
    payload.profiles = {
      fast: trainingManager.profileInfo('fast'),
      balanced: trainingManager.profileInfo('balanced'),
      large: trainingManager.profileInfo('large')
    };
    return sendJson(res, 200, payload);
  }
  if (pathname === '/api/training/start' && req.method === 'POST') {
    if (!isLoopback(req)) return sendJson(res, 403, { error: '训练只能从服务器本机启动' });
    try { return sendJson(res, 200, trainingManager.start(await readJsonBody(req))); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (pathname === '/api/training/stop' && req.method === 'POST') {
    if (!isLoopback(req)) return sendJson(res, 403, { error: '训练只能从服务器本机停止' });
    return sendJson(res, 200, trainingManager.stop());
  }
  if (req.url === '/api/agent/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(agentStatus()));
  }
  if (req.url === '/api/neural/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(localNeuralBot.status()));
  }
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
  const info = { id: null, name: '玩家', roomId: null, lastSeenAt: Date.now() };
  clients.set(socket, info);
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const r = wsParse(buf);
    buf = r.rest;
    r.messages.forEach(str => {
      let msg;
      try { msg = JSON.parse(str); } catch (e) { return; }
      info.lastSeenAt = Date.now();
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
      // 刷新/重连时新连接可能已经接管同一座位，旧连接关闭不能把真人再次标成电脑。
      const replacement = Array.from(clients.values()).some(c => c.id === info.id && c.roomId === info.roomId);
      if (replacement) { sendPersonal(r); return; }
      const s = r.seats.find(x => x.id === info.id);
      if (s) {
        // 断线后自动由电脑托管，但保留真人座位，允许原玩家凭令牌重连。
        s.disconnected = true;
        s.left = false;
        if (r.state && r.state.phase !== 'gameover') {
          const ps = r.state.players.find(p => p.id === s.id);
          if (ps) ps.isBot = true;
          CitEngine.log(r.state, s.name + ' 已断连，由电脑托管。', 'sys');
          sendRoomNotice(r, { kind: 'player_disconnected', playerId: s.id, playerName: s.name }, info.id);
          botTick(r);
        } else sendRoomNotice(r, { kind: 'player_disconnected', playerId: s.id, playerName: s.name }, info.id);
      }
      sendPersonal(r);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  clients.forEach((info, socket) => {
    if (info.roomId && now - info.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      try { socket.destroy(); } catch (e) { /* ignore */ }
    }
  });
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  if (process.send) process.send({ type: 'listening', port: server.address().port });
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
  if (useLocalCodex) console.log('  AI Agent：  本机 ' + localCodex.version + '（无需另配 API）');
  else console.log('  AI Agent：  ' + agentStatus().message);
  console.log('  本地神经网络：' + localNeuralBot.status().message);
  console.log('');
});
