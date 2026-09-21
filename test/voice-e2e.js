/* 联机语音端到端验证：真实浏览器 + 真实 LiveKit 服务器。
 *
 * 需要先准备好：
 *   1) 本机 LiveKit dev 服务器：livekit-server --dev --bind 127.0.0.1   （devkey/secret）
 *   2) playwright-core（用系统 Edge，不需要额外下浏览器）
 *
 * 用法：node test/voice-e2e.js
 * 环境变量：LIVEKIT_WS / LIVEKIT_KEY / LIVEKIT_SECRET / BROWSER_CHANNEL
 *          E2E_BASE=https://23.144.4.81  直接打已部署的服务器（不再本机起服务）
 *          E2E_IGNORE_CERT=1             自签证书，忽略证书校验
 */
'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');

const LIVEKIT_WS = process.env.LIVEKIT_WS || 'ws://127.0.0.1:7880';
const LIVEKIT_KEY = process.env.LIVEKIT_KEY || 'devkey';
const LIVEKIT_SECRET = process.env.LIVEKIT_SECRET || 'secret';
const CHANNEL = process.env.BROWSER_CHANNEL || 'msedge';
const E2E_BASE = (process.env.E2E_BASE || '').replace(/\/+$/, '');
const IGNORE_CERT = process.env.E2E_IGNORE_CERT === '1';

const wait = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await wait(150);
  }
  throw new Error('等待超时：' + label + '（最后一次结果：' + JSON.stringify(last) + '）');
}

async function startGameServer() {
  const child = fork(path.join(__dirname, '..', 'server.js'), ['0'], {
    cwd: path.join(__dirname, '..'), silent: true,
    env: Object.assign({}, process.env, {
      LIVEKIT_URL: LIVEKIT_WS,
      LIVEKIT_API_KEY: LIVEKIT_KEY,
      LIVEKIT_API_SECRET: LIVEKIT_SECRET,
      CITADELS_DISABLE_LOCAL_CODEX: '1'
    })
  });
  let port, output = '';
  child.on('message', m => { if (m.type === 'listening') port = m.port; });
  child.stdout.on('data', s => { output += s; });
  child.stderr.on('data', s => { output += s; });
  await until(() => port, '游戏服务器启动');
  return {
    base: 'http://127.0.0.1:' + port,
    close: async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } },
    output: () => output
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  → ' + detail : ''));
}

/* 桌面端的顶栏是右下角 ☰ 浮动菜单，语音按钮和「发言」都在里面。 */
async function openMenu(page) {
  if (await page.isVisible('#btn-voice')) return;
  await page.click('#mobile-menu-toggle');
  await until(() => page.isVisible('#btn-voice'), '展开菜单后出现语音按钮');
}

async function main() {
  const server = E2E_BASE
    ? { base: E2E_BASE, close: async () => {}, output: () => '' }
    : await startGameServer();
  const browser = await chromium.launch({
    channel: CHANNEL,
    args: [
      '--use-fake-device-for-media-stream',   // 合成麦克风输入，不需要真实设备
      '--use-fake-ui-for-media-stream',       // 自动同意权限弹窗
      '--autoplay-policy=no-user-gesture-required',
      // 页面里的 wss:// 是浏览器自己发起的，context 的 ignoreHTTPSErrors 管不到，
      // 自签证书场景要靠这个开关。
      ...(IGNORE_CERT ? ['--ignore-certificate-errors'] : [])
    ]
  });

  const ctxA = await browser.newContext({ permissions: ['microphone'], ignoreHTTPSErrors: IGNORE_CERT });
  const ctxB = await browser.newContext({ permissions: ['microphone'], ignoreHTTPSErrors: IGNORE_CERT });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on('pageerror', e => console.log('  [A pageerror]', e.message));
  pageB.on('pageerror', e => console.log('  [B pageerror]', e.message));

  try {
    await pageA.goto(server.base, { waitUntil: 'domcontentloaded' });
    await pageB.goto(server.base, { waitUntil: 'domcontentloaded' });

    // ---- 甲：创建 2 人房间，语音开启 ----
    await pageA.click('#btn-online');
    await pageA.fill('#net-name', '甲');
    await pageA.selectOption('#net-players', '2');
    await pageA.selectOption('#net-bots', '0');
    // 服务器已配 LiveKit，房间语音开关应当出现
    await until(() => pageA.isVisible('#net-voice'), '创建表单出现语音开关');
    check('服务器配好 LiveKit 后，创建房间表单显示语音开关', true);
    await pageA.selectOption('#net-voice', 'on');
    await pageA.click('#btn-create');
    const roomCode = await until(async () => {
      const code = await pageA.textContent('#r-code');
      return /^[A-Z0-9]{4}$/.test((code || '').trim()) ? code.trim() : null;
    }, '房间创建');
    check('创建房间成功：' + roomCode, true);
    check('房间配置行显示语音开关', await pageA.isVisible('#r-voice'));

    // ---- 乙：加入同一房间 ----
    await pageB.click('#btn-online');
    await pageB.fill('#net-name', '乙');
    await pageB.fill('#net-code', roomCode);
    await pageB.click('#btn-join');
    await until(async () => !(await pageB.isVisible('#lobby-pre')), '乙进入房间');
    await until(async () => (await pageA.textContent('#seat-grid')).includes('乙'), '甲看到乙入座');
    check('第二名玩家加入房间', true);

    // ---- 大厅里房主可以改语音开关（开局后这个入口就收起来了）----
    await pageA.selectOption('#r-voice', 'off');
    await until(async () => {
      const st = await pageB.evaluate(() => window.__CitadelsApp.lobbyState);
      return st && st.config && st.config.voice === false;
    }, '乙收到语音关闭');
    check('房主关闭房间语音后，乙端同步到开关值', true);

    const denied = await pageB.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('citadels.net.session') || '{}');
      const res = await fetch(location.origin + '/api/voice/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: s.roomId, resumeToken: s.token })
      });
      return { status: res.status, body: await res.json() };
    });
    check('语音关闭时服务器拒绝签发令牌', denied.status === 403, JSON.stringify(denied.body));

    await pageA.selectOption('#r-voice', 'on');
    await until(async () => {
      const st = await pageB.evaluate(() => window.__CitadelsApp.lobbyState);
      return st && st.config && st.config.voice === true;
    }, '语音重新开启');
    check('重新打开语音开关', true);

    // ---- 开局（语音入口在对局顶栏，和文字聊天一致）----
    await pageA.click('#btn-net-start');
    await until(() => pageA.isVisible('#screen-game'), '甲进入对局');
    await until(() => pageB.isVisible('#screen-game'), '乙进入对局');
    check('房主开局后双方进入对局界面', true);

    // ---- 双方加入语音 ----
    await openMenu(pageA);
    check('展开游戏菜单后出现语音按钮', true);
    await pageA.click('#btn-voice');
    await until(() => pageA.evaluate(() => window.__CitadelsApp.__voice.joined), '甲加入语音', 25000);
    check('甲加入语音（取令牌 → 连 LiveKit → 上麦）', true);

    // 开麦是 connect 之后单独一步（要等浏览器权限），这里等它落定再断言。
    const aState = await until(async () => {
      const v = await pageA.evaluate(() => {
        const x = window.__CitadelsApp.__voice;
        return {
          room: x.room.name,
          localIdentity: x.room.localParticipant.identity,
          micEnabled: x.room.localParticipant.isMicrophoneEnabled,
          muted: x.muted,
          canPlayback: x.room.canPlaybackAudio,
          panelOpen: !!document.getElementById('pane-voice') && !document.getElementById('pane-voice').hidden
        };
      });
      return v.micEnabled ? v : null;
    }, '甲开麦完成', 20000);
    check('LiveKit 房间名与游戏房号一致（citadels-' + roomCode + '）', aState.room === 'citadels-' + roomCode,
      aState.room);
    check('本地麦克风已发布', aState.micEnabled === true);
    check('浏览器允许播放远端音频', aState.canPlayback === true);
    check('加入语音后自动打开语音面板', await pageA.isVisible('#pane-voice'));

    await openMenu(pageB);
    await pageB.click('#btn-voice');
    await until(() => pageB.evaluate(() => window.__CitadelsApp.__voice.joined), '乙加入语音', 25000);
    check('乙加入语音', true);

    // ---- 互相看见 + 真的订阅到对方的音轨 ----
    const cross = await until(async () => {
      const a = await pageA.evaluate(() => {
        const v = window.__CitadelsApp.__voice;
        return {
          remotes: Array.from(v.room.remoteParticipants.values()).map(p => ({
            id: p.identity, name: p.name,
            audio: Array.from(p.audioTrackPublications.values()).map(pub => ({
              subscribed: !!pub.isSubscribed, muted: !!pub.isMuted
            }))
          })),
          roster: v.roster()
        };
      });
      const subscribed = a.remotes.some(r => r.audio.some(x => x.subscribed));
      return subscribed ? a : null;
    }, '甲订阅到乙的音轨', 25000);
    check('甲在语音房间里看到乙', cross.remotes.length === 1 && cross.remotes[0].name === '乙',
      JSON.stringify(cross.remotes.map(r => r.name)));
    check('甲已订阅乙的远端音轨', cross.remotes[0].audio.some(x => x.subscribed));
    check('语音面板列出双方', cross.roster.length === 2, cross.roster.map(r => r.name + (r.muted ? '(静音)' : '')).join(' / '));

    const audioNodes = await pageA.evaluate(() => {
      const box = document.getElementById('voice-audio');
      return Array.from(box.querySelectorAll('audio')).map(n => ({ paused: n.paused, src: !!n.srcObject }));
    });
    check('远端音轨已挂到 DOM 且正在播放', audioNodes.length === 1 && audioNodes[0].paused === false,
      JSON.stringify(audioNodes));

    // ---- 说话提示：合成音源会持续发声，等 ActiveSpeakersChanged ----
    const speaking = await until(async () => {
      const s = await pageA.evaluate(() => Array.from(window.__CitadelsApp.__voice.speakers));
      return s.length ? s : null;
    }, '甲看到有人在说话', 20000).catch(() => null);
    check('收到活跃说话人事件（服务端语音活动检测）', !!speaking, speaking ? speaking.join(',') : '未在超时内触发');

    // ---- 静音：走语音面板里的按钮（加入后侧栏已自动展开，日常也更顺手）----
    await until(() => pageA.isVisible('#pane-voice'), '语音面板可见');
    const muteBtn = pageA.locator('#voice-pane .voice-foot button').first();
    await muteBtn.click();
    const muted = await until(async () => {
      const v = await pageA.evaluate(() => {
        const x = window.__CitadelsApp.__voice;
        return {
          muted: x.muted,
          panel: (document.querySelector('#voice-pane .voice-foot button') || {}).textContent,
          topbar: document.getElementById('btn-voice').textContent
        };
      });
      return v.muted ? v : null;
    }, '甲静音');
    check('面板里的静音按钮生效', muted.muted === true, '面板显示「' + muted.panel + '」，顶栏显示「' + muted.topbar + '」');
    check('顶栏按钮同步显示静音态', /静音/.test(muted.topbar), muted.topbar);

    // ---- 乙看到甲静音 ----
    await until(async () => {
      const r = await pageB.evaluate(() => window.__CitadelsApp.__voice.roster().find(x => x.name === '甲'));
      return r && r.muted;
    }, '乙看到甲静音').then(() => check('乙的名单里甲显示为静音', true))
      .catch(() => check('乙的名单里甲显示为静音', false, '未在超时内更新'));

    // ---- 顶栏按钮：重新展开菜单后点一下应当开麦 ----
    await openMenu(pageA);
    await pageA.click('#btn-voice');
    await until(async () => {
      const m = await pageA.evaluate(() => window.__CitadelsApp.__voice.muted);
      return m === false;
    }, '甲重新开麦').then(() => check('菜单里的语音按钮可切换开麦/静音', true))
      .catch(() => check('菜单里的语音按钮可切换开麦/静音', false, '状态未变化'));

    // ---- 退出语音：连接断开、DOM 清空 ----
    await pageA.evaluate(() => window.__CitadelsApp.__voice.leave());
    await until(async () => {
      const ok = await pageA.evaluate(() => {
        const v = window.__CitadelsApp.__voice;
        return !v.joined && !v.room && document.getElementById('voice-audio').children.length === 0;
      });
      return ok;
    }, '甲退出语音').then(() => check('退出语音后断开连接并清空音轨节点', true))
      .catch(() => check('退出语音后断开连接并清空音轨节点', false, '状态未清理'));

    // ---- 乙侧应看到甲离开 ----
    await until(async () => {
      const n = await pageB.evaluate(() => window.__CitadelsApp.__voice.room.remoteParticipants.size);
      return n === 0;
    }, '乙看到甲离开语音', 15000).then(() => check('甲退出后乙的远端列表清空', true))
      .catch(() => check('甲退出后乙的远端列表清空', false, '未在超时内移除'));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log('端到端语音验证：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
  if (failed.length) {
    console.log('失败项：');
    failed.forEach(f => console.log('  - ' + f.name + (f.detail ? '  → ' + f.detail : '')));
    process.exitCode = 1;
  }
}

main().catch(e => { console.error('E2E 运行失败：', e); process.exitCode = 1; });
