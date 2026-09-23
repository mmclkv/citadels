'use strict';

const assert = require('assert');
const test = require('node:test');
const { buildConfig } = require('../lib/frp-manager.js');

test('FRP HTTP 配置生成不泄露 token 到日志接口以外', () => {
  const old = { ...process.env };
  try {
    process.env.CITADELS_FRP_SERVER_ADDR = 'frps.example.com';
    process.env.CITADELS_FRP_SERVER_PORT = '7000';
    process.env.CITADELS_FRP_TOKEN = 'secret-token';
    process.env.CITADELS_FRP_TYPE = 'http';
    process.env.CITADELS_FRP_DOMAIN = 'game.example.com';
    const config = buildConfig({ port: 8787 });
    assert.match(config, /serverAddr = "frps\.example\.com"/);
    assert.match(config, /localPort = 8787/);
    assert.match(config, /customDomains = \["game\.example\.com"\]/);
    assert.match(config, /auth\.token = "secret-token"/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in old)) delete process.env[key];
    }
    Object.assign(process.env, old);
  }
});

test('FRP TCP 配置要求并写入远端端口', () => {
  const old = { ...process.env };
  try {
    process.env.CITADELS_FRP_SERVER_ADDR = 'frps.example.com';
    process.env.CITADELS_FRP_TOKEN = 'secret-token';
    process.env.CITADELS_FRP_TYPE = 'tcp';
    process.env.CITADELS_FRP_REMOTE_PORT = '18787';
    const config = buildConfig({ port: 8787 });
    assert.match(config, /type = "tcp"/);
    assert.match(config, /remotePort = 18787/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in old)) delete process.env[key];
    }
    Object.assign(process.env, old);
  }
});
