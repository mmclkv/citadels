'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function tomlString(value) {
  return JSON.stringify(String(value));
}

function resolveExecutable(requested) {
  if (!requested) return '';
  if (fs.existsSync(requested)) return requested;
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [requested], {
    encoding: 'utf8', windowsHide: true
  });
  return String(lookup.stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function frpcPath() {
  return resolveExecutable(process.env.CITADELS_FRPC_PATH ||
    (process.platform === 'win32' ? 'frpc.exe' : 'frpc'));
}

function enabled() {
  return process.env.CITADELS_FRP_ENABLED === '1';
}

function buildConfig({ port }) {
  const serverAddr = String(process.env.CITADELS_FRP_SERVER_ADDR || '').trim();
  const serverPort = Number(process.env.CITADELS_FRP_SERVER_PORT || 7000);
  const token = String(process.env.CITADELS_FRP_TOKEN || '');
  const type = String(process.env.CITADELS_FRP_TYPE || 'http').trim().toLowerCase();
  const localPort = Number(process.env.CITADELS_FRP_LOCAL_PORT || port);
  const name = String(process.env.CITADELS_FRP_NAME || 'citadels').trim() || 'citadels';
  const tls = process.env.CITADELS_FRP_TLS !== '0';
  if (!serverAddr) throw new Error('未设置 CITADELS_FRP_SERVER_ADDR');
  if (!token) throw new Error('未设置 CITADELS_FRP_TOKEN');
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error('CITADELS_FRP_SERVER_PORT 无效');
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error('CITADELS_FRP_LOCAL_PORT 无效');
  }
  if (!['http', 'https', 'tcp'].includes(type)) {
    throw new Error('CITADELS_FRP_TYPE 只能是 http、https 或 tcp');
  }
  const lines = [
    'serverAddr = ' + tomlString(serverAddr),
    'serverPort = ' + serverPort,
    'auth.method = "token"',
    'auth.token = ' + tomlString(token),
    'transport.tls.enable = ' + (tls ? 'true' : 'false'),
    '',
    '[[proxies]]',
    'name = ' + tomlString(name),
    'type = ' + tomlString(type),
    'localIP = "127.0.0.1"',
    'localPort = ' + localPort
  ];
  if (type === 'tcp') {
    const remotePort = Number(process.env.CITADELS_FRP_REMOTE_PORT || 0);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new Error('TCP 穿透需要设置有效的 CITADELS_FRP_REMOTE_PORT');
    }
    lines.push('remotePort = ' + remotePort);
  } else {
    const domain = String(process.env.CITADELS_FRP_DOMAIN || '').trim();
    if (!domain) throw new Error('HTTP/HTTPS 穿透需要设置 CITADELS_FRP_DOMAIN');
    lines.push('customDomains = [' + tomlString(domain) + ']');
  }
  return lines.join('\n') + '\n';
}

class FrpManager {
  constructor({ port, root, log = console.log } = {}) {
    this.port = port;
    this.root = root;
    this.log = log;
    this.child = null;
    this.generatedConfig = '';
  }

  status() {
    return {
      enabled: enabled(),
      configured: enabled() && !!process.env.CITADELS_FRP_CONFIG ||
        (enabled() && !!process.env.CITADELS_FRP_SERVER_ADDR && !!process.env.CITADELS_FRP_TOKEN),
      running: !!(this.child && this.child.exitCode == null),
      type: process.env.CITADELS_FRP_TYPE || 'http',
      domain: process.env.CITADELS_FRP_DOMAIN || '',
      remotePort: Number(process.env.CITADELS_FRP_REMOTE_PORT || 0) || null
    };
  }

  async start() {
    if (!enabled()) {
      this.log('[frp] 未启用（设置 CITADELS_FRP_ENABLED=1 后重启）');
      return null;
    }
    if (this.child && this.child.exitCode == null) return this.child;
    const executable = frpcPath();
    if (!executable) throw new Error('未找到 frpc，请安装 FRP 或设置 CITADELS_FRPC_PATH');
    let configPath = String(process.env.CITADELS_FRP_CONFIG || '').trim();
    if (configPath) {
      if (!fs.existsSync(configPath)) throw new Error('FRP 配置文件不存在：' + configPath);
      this.log('[frp] 使用外部配置：' + configPath);
    } else {
      const config = buildConfig({ port: this.port });
      configPath = path.join(os.tmpdir(), 'citadels-frpc-' + process.pid + '.toml');
      fs.writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o600 });
      this.generatedConfig = configPath;
      this.log('[frp] 已生成临时配置，目标：' +
        (process.env.CITADELS_FRP_TYPE === 'tcp' ? 'TCP' : (process.env.CITADELS_FRP_DOMAIN || 'HTTP')));
    }
    this.log('[frp] 启动 frpc：' + executable);
    this.child = spawn(executable, ['-c', configPath], {
      cwd: this.root, env: process.env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = data => {
      const text = String(data).trim();
      if (text) text.split(/\r?\n/).forEach(line => this.log('[frp] ' + line));
    };
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', output);
    this.child.stderr.on('data', output);
    this.child.on('error', error => this.log('[frp] 启动失败：' + error.message));
    this.child.on('exit', (code, signal) => {
      this.log('[frp] frpc 已退出（code=' + code + '，signal=' + (signal || 'none') + '）');
      this.child = null;
    });
    return this.child;
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null) {
      try { child.kill(); } catch (_) { /* already exited */ }
    }
    if (this.generatedConfig) {
      try { fs.rmSync(this.generatedConfig, { force: true }); } catch (_) { /* best effort */ }
      this.generatedConfig = '';
    }
  }
}

module.exports = { FrpManager, buildConfig, enabled, frpcPath };
