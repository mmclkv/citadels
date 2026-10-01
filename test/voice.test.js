'use strict';

/* 联机语音：从 Python 服务端到浏览器配置的令牌签发与访问控制。
 *
 * 这里用 crypto 独立复算 HMAC，而不是复用服务端实现来验签，
 * HMAC，并逐条核对 claim —— 令牌格式一旦写错，LiveKit 会直接拒绝连接，
 * 而那种失败在浏览器里只表现为「连不上语音」，很难定位。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { connect, until } = require('./agent-harness');
const { startPythonServer } = require('./python-server-process');


const API_KEY = 'APItestkey123456';
const API_SECRET = 'test-secret-value-for-hmac-signing-0123456789';
const VOICE_URL = 'wss://voice.example.test';

function b64urlDecode(part) {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/* 独立验签：拆开 JWT，用 API Secret 复算 HMAC-SHA256 并对比签名。 */
function verifyJwt(token, secret) {
  const parts = String(token).split('.');
  assert.equal(parts.length, 3, 'JWT 必须是三段式');
  const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const actual = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(actual.length, expected.length, '签名长度不一致');
  assert.ok(crypto.timingSafeEqual(actual, expected), '签名不匹配');
  return { header: JSON.parse(b64urlDecode(parts[0])), payload: JSON.parse(b64urlDecode(parts[1])) };
}

/* 语音服务和 agent 的 mock 模型无关，这里只起一个带 LIVEKIT_* 的真实服务器。 */
async function voiceFixture(env) {
  const server = await startPythonServer(env || {});
  return { base: server.base, close: server.close, output: server.output };
}

const CONFIGURED = {
  LIVEKIT_URL: VOICE_URL,
  LIVEKIT_API_KEY: API_KEY,
  LIVEKIT_API_SECRET: API_SECRET
};

async function tokenRequest(base, body, method) {
  const init = {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' }
  };
  // GET/HEAD 不允许带 body，预检也不带。
  if (init.method === 'POST') init.body = JSON.stringify(body);
  const res = await fetch(base + '/api/voice/token', init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 预检没有响应体 */ }
  return { status: res.status, json: json, headers: res.headers };
}

test('未配置 LiveKit 的服务器：状态如实上报，签发接口返回 503', async t => {
  const f = await voiceFixture({ CITADELS_DISABLE_LOCAL_CODEX: '1' });
  t.after(f.close);

  const status = await (await fetch(f.base + '/api/voice/status')).json();
  assert.equal(status.configured, false);
  assert.match(status.message, /LIVEKIT_URL/);

  const res = await tokenRequest(f.base, { roomId: 'AB3D', resumeToken: 'x' });
  assert.equal(res.status, 503);
  assert.match(res.json.error, /LIVEKIT_URL/);
});

test('签发接口：真人座位拿到可用令牌，其他情况一律拒绝', async t => {
  const f = await voiceFixture(CONFIGURED);
  t.after(f.close);

  const status = await (await fetch(f.base + '/api/voice/status')).json();
  assert.equal(status.configured, true);
  assert.equal(status.url, undefined, '状态接口不该回传服务器地址');

  const host = await connect(f.base, '房主');
  const guest = await connect(f.base, '访客');
  t.after(host.close);
  t.after(guest.close);
  host.send({ t: 'createRoom', name: '房主', config: { playerCount: 3, bots: 1 } });
  await until(() => host.state && host.state.roomId, 'room creation');
  const roomId = host.state.roomId;
  guest.send({ t: 'joinRoom', roomId: roomId, name: '访客' });
  await until(() => guest.id && guest.state && guest.state.roomId === roomId, 'guest join');

  // 1) 持有效 resumeToken 的真人
  const ok = await tokenRequest(f.base, { roomId: roomId, resumeToken: guest.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*', '跨域前端要能直接调用');
  // 响应里只能有连接所需的信息，不能夹带 API Secret 之类
  assert.deepEqual(Object.keys(ok.json).sort(),
    ['expiresAt', 'identity', 'room', 'token', 'url']);
  assert.equal(ok.json.identity, guest.id);
  assert.equal(ok.json.room, 'citadels-' + roomId);
  assert.equal(ok.json.url, VOICE_URL);

  const { payload } = verifyJwt(ok.json.token, API_SECRET);
  assert.equal(payload.sub, guest.id, '令牌身份必须等于座位 id');
  assert.equal(payload.name, '访客');
  assert.equal(payload.video.room, 'citadels-' + roomId);

  // 2) 缺令牌 / 令牌不对
  assert.equal((await tokenRequest(f.base, { roomId: roomId })).status, 403);
  assert.equal((await tokenRequest(f.base, { roomId: roomId, resumeToken: 'deadbeef' })).status, 403);

  // 3) 房号写错不影响安全性：签发的房间始终取自令牌所属的真实房间，
  //    伪造 roomId 拿不到别的房间的令牌（房号只当查询提示用）。
  const wrongRoom = await tokenRequest(f.base, { roomId: 'ZZZZ', resumeToken: guest.token });
  assert.equal(wrongRoom.status, 200);
  assert.equal(wrongRoom.json.room, 'citadels-' + roomId);

  // 4) 房间开关关掉后立刻失效
  host.send({ t: 'config', config: { voice: false } });
  await until(async () => {
    const res = await tokenRequest(f.base, { roomId: roomId, resumeToken: guest.token });
    return res.status === 403 ? res : null;
  }, 'voice disabled rejection');

  // 5) 重新打开后又能签发
  host.send({ t: 'config', config: { voice: true } });
  await until(async () => (await tokenRequest(f.base, { roomId: roomId, resumeToken: guest.token })).status === 200,
    'voice re-enabled');
});

test('签发接口：座位被改成电脑后，原令牌立即失效（电脑不参与语音）', async t => {
  const f = await voiceFixture(CONFIGURED);
  t.after(f.close);
  const host = await connect(f.base, '房主');
  const guest = await connect(f.base, '访客');
  t.after(host.close);
  t.after(guest.close);

  host.send({ t: 'createRoom', name: '房主', config: { playerCount: 2, bots: 0 } });
  await until(() => host.state && host.state.roomId, 'room creation');
  const roomId = host.state.roomId;
  guest.send({ t: 'joinRoom', roomId: roomId, name: '访客' });
  await until(() => guest.id && guest.state && guest.state.roomId === roomId, 'guest join');
  assert.equal((await tokenRequest(f.base, { roomId: roomId, resumeToken: guest.token })).status, 200);

  // 房主把 2 号座位换成电脑：座位换了 id、也清掉了 resumeToken
  host.send({ t: 'setSeat', index: 1, kind: 'bot' });
  await until(() => host.state && host.state.seats && host.state.seats[1].isBot, 'seat became bot');

  const after = await tokenRequest(f.base, { roomId: roomId, resumeToken: guest.token });
  assert.equal(after.status, 403, '被替换成电脑的座位不能再拿语音令牌');
});

test('签发接口：预检请求带 CORS 头，非 POST 方法被拒绝', async t => {
  const f = await voiceFixture(CONFIGURED);
  t.after(f.close);

  const preflight = await fetch(f.base + '/api/voice/token', {
    method: 'OPTIONS',
    headers: { 'Origin': 'https://example.github.io', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/i);

  const res = await tokenRequest(f.base, null, 'GET');
  assert.equal(res.status, 405);
});

test('房间配置：语音开关会随大厅与对局视图一起下发', async t => {
  const f = await voiceFixture(CONFIGURED);
  t.after(f.close);
  const host = await connect(f.base, '房主');
  t.after(host.close);

  host.send({ t: 'createRoom', name: '房主', config: { playerCount: 2, bots: 1, voice: false } });
  await until(() => host.state && host.state.roomId, 'room creation');
  assert.equal(host.state.config.voice, false, '大厅视图要带上开关值');
  assert.equal(host.state.voiceReady, true, '大厅视图要告诉客户端服务器支持语音');

  host.send({ t: 'config', config: { voice: true } });
  await until(() => host.state && host.state.config.voice === true, 'voice toggled on');

  host.send({ t: 'startGame' });
  await until(() => host.state && host.state.phase !== 'lobby', 'game start');
  assert.equal(host.state.voiceEnabled, true, '对局视图要带上语音开关');
  assert.equal(host.state.voiceReady, true);
});

test('前端接线：语音入口、侧栏、音频容器与懒加载路径都在', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

  assert.match(html, /id="btn-voice"[^>]*>语音<\/button>/);
  assert.match(html, /id="tab-voice"[^>]*>语音<\/button>/);
  assert.match(html, /id="pane-voice"[^>]*>/);
  assert.match(html, /id="voice-audio"[^>]*>/);
  assert.match(html, /id="net-voice"/);
  assert.match(html, /id="r-voice"/);

  // 音量滑杆占用指针，说话状态只能靠切 class，不能整块重建面板
  assert.match(app, /function syncVoiceIndicators\(\)/);
  assert.match(app, /voicePanelSignature\(\)/);
  // SDK 懒加载：单机玩家不该下载 600KB 的语音组件
  assert.match(app, /vendor\/livekit-client\.umd\.min\.js/);
  assert.match(app, /localParticipant\.setMicrophoneEnabled\(/);
  assert.match(app, /RoomEvent\.ActiveSpeakersChanged|E\.ActiveSpeakersChanged/);
  assert.match(app, /remoteParticipants\.get\(identity\)|setVolume\(this\.volumeOf/);
  // 非 HTTPS 页面要给出人话，而不是把 SDK 的英文报错原样抛给用户
  assert.match(app, /navigator\.mediaDevices/);

  // 预缓存的 APP_SHELL 不能包含语音 SDK，运行时缓存会接管它
  const shell = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(shell, 'sw.js 应该有 APP_SHELL');
  assert.doesNotMatch(shell[1], /livekit/);
});

test('服务端接线：令牌接口只在鉴权通过后签发，且不下发 API Secret', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'python_backend', 'server.py'), 'utf8');
  const voice = fs.readFileSync(path.join(__dirname, '..', 'python_backend', 'voice.py'), 'utf8');
  assert.match(server, /from \.voice import VoiceService/);
  assert.match(server, /route == "\/api\/voice\/token"/);
  assert.match(server, /route == "\/api\/voice\/status"/);
  assert.match(server, /self\.rooms\.resume_room\(str\(body\.get\("resumeToken"\)/);
  assert.match(server, /seat\["isBot"\]/);
  assert.match(server, /self\._voice_throttled\(ip_key\)/);
  assert.match(voice, /hmac\.new\(/, 'JWT 必须由服务端密钥签名');
  assert.doesNotMatch(server + voice, /apiSecret/, '服务端响应不得包含 API Secret 字段');
});
