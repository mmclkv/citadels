/* =========================================================================
 * 富饶之城 — 联机语音（LiveKit 访问令牌签发）
 *
 * 本模块只做一件事：给「同一个游戏房间里的真人座位」签发一枚短期 LiveKit
 * 访问令牌。音频流由 LiveKit 在浏览器之间转发，不经过本服务器；API Secret
 * 只在服务器内存里参与 HMAC 签名，绝不下发给浏览器或局域网玩家。
 *
 * 配置（都放在运行游戏服务器的机器上，参见 README 的「联机语音」一节）：
 *   LIVEKIT_URL          wss://xxx.livekit.cloud 或自建 wss://voice.example.com
 *   LIVEKIT_API_KEY
 *   LIVEKIT_API_SECRET
 *
 * 令牌结构按 LiveKit 官方 server-sdk 的 AccessToken 实现生成：
 *   header  { alg: 'HS256', typ: 'JWT' }
 *   payload { iss, sub, nbf, exp, name, video: { roomJoin, room, canPublish, canSubscribe } }
 * 只用 Node 内置 crypto 做 HMAC-SHA256，不引入 jose 等依赖。
 * ========================================================================= */
'use strict';

const crypto = require('crypto');

// 官方 server-sdk 的默认有效期是 6 小时；一局桌游远短于这个数，沿用即可，
// 中途刷新页面也能用同一枚令牌重连语音。
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
// 允许一点时钟偏差，避免服务器与 LiveKit 时间不同步时令牌被判为「尚未生效」。
const CLOCK_SKEW_SECONDS = 5;
const ROOM_PREFIX = 'citadels-';
const MAX_NAME_LENGTH = 24;

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function clampTtl(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, n));
}

/* HS256 JWT。LiveKit 只校验签名与 claim，不需要引入 JWT 库。 */
function signJwt(payload, apiKey, apiSecret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = Object.assign({ iss: apiKey }, payload);
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', apiSecret).update(signingInput).digest();
  return signingInput + '.' + base64url(signature);
}

function normalizeUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  if (!/^wss?:\/\/|^https?:\/\//i.test(url)) return '';
  return url.replace(/\/+$/, '');
}

function roomNameFor(roomId) {
  return ROOM_PREFIX + String(roomId || '').toUpperCase();
}

function cleanName(name) {
  return Array.from(String(name || '').replace(/[\r\n\t]+/g, ' ').trim())
    .slice(0, MAX_NAME_LENGTH).join('') || '玩家';
}

function createVoiceService(options) {
  const env = (options && options.env) || process.env;
  const url = normalizeUrl(env.LIVEKIT_URL);
  const apiKey = String(env.LIVEKIT_API_KEY || '').trim();
  const apiSecret = String(env.LIVEKIT_API_SECRET || '').trim();
  const ttlSeconds = clampTtl(env.LIVEKIT_TOKEN_TTL);

  const missing = [];
  if (!url) missing.push('LIVEKIT_URL');
  if (!apiKey) missing.push('LIVEKIT_API_KEY');
  if (!apiSecret) missing.push('LIVEKIT_API_SECRET');
  const configured = missing.length === 0;

  function status() {
    return {
      configured,
      url: configured ? url : '',
      ttlSeconds,
      message: configured
        ? '联机语音已就绪（LiveKit）'
        : '服务器未配置联机语音，需要设置 ' + missing.join(' / ')
    };
  }

  /* 签发一枚只能用于指定房间的令牌。调用方负责确认请求者确实是该房间的真人座位。 */
  function tokenFor(request) {
    if (!configured) throw new Error(status().message);
    const roomId = String((request && request.roomId) || '').trim().toUpperCase();
    const identity = String((request && request.identity) || '').trim();
    if (!/^[A-Z0-9]{4}$/.test(roomId)) throw new Error('房间号无效');
    if (!identity) throw new Error('缺少玩家标识');
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;
    const room = roomNameFor(roomId);
    const token = signJwt({
      sub: identity,
      nbf: now - CLOCK_SKEW_SECONDS,
      exp: exp,
      name: cleanName(request && request.name),
      video: {
        roomJoin: true,
        room: room,
        canPublish: true,
        canSubscribe: true
      }
    }, apiKey, apiSecret);
    return { token: token, url: url, room: room, identity: identity, expiresAt: exp * 1000 };
  }

  return {
    configured: configured,
    url: configured ? url : '',
    ttlSeconds: ttlSeconds,
    status: status,
    tokenFor: tokenFor,
    roomNameFor: roomNameFor
  };
}

module.exports = {
  createVoiceService: createVoiceService,
  roomNameFor: roomNameFor,
  signJwt: signJwt,
  clampTtl: clampTtl,
  ROOM_PREFIX: ROOM_PREFIX,
  DEFAULT_TTL_SECONDS: DEFAULT_TTL_SECONDS
};
