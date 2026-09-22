'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function resolveCommand(command) {
  if (!command) return '';
  if (fs.existsSync(command)) return command;
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8', windowsHide: true
  });
  return String(lookup.stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function findCompiler() {
  const requested = process.env.CXX;
  const candidates = [
    requested,
    process.env.LLVM_ROOT && path.join(process.env.LLVM_ROOT, 'bin', process.platform === 'win32' ? 'clang++.exe' : 'clang++'),
    process.platform === 'win32' && process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'LLVM', 'bin', 'clang++.exe'),
    process.platform === 'win32' && process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'LLVM', 'bin', 'clang++.exe'),
    'clang++', 'g++', 'c++'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate);
    if (resolved) return resolved;
  }
  return '';
}

function validTorchRoot(item) {
  return !!item && fs.existsSync(path.join(item, 'include')) && fs.existsSync(path.join(item, 'lib'));
}

function pythonTorchRoot(python) {
  const probe = spawnSync(python, ['-c',
    'import os, torch; print(os.path.dirname(torch.__file__))'],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (probe.status !== 0) return '';
  const item = String(probe.stdout || '').trim().split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return validTorchRoot(item) ? item : '';
}

function findPython(root) {
  const candidates = [
    process.env.PYTHON,
    process.env.CITADELS_PYTHON,
    path.join(root, '.python', 'python.exe'),
    path.join(root, '.python', 'bin', 'python'),
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'bin', 'python'),
    process.platform === 'win32' ? 'python' : 'python3',
    'python'
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate);
    if (resolved) return resolved;
  }
  return '';
}

function findTorchRoot(root) {
  const explicit = process.env.CITADELS_LIBTORCH;
  if (validTorchRoot(explicit)) return explicit;
  const candidates = [
    path.join(root, '.python', 'Lib', 'site-packages', 'torch'),
    path.join(root, '.python', 'lib', 'site-packages', 'torch'),
    path.join(root, '.venv', 'Lib', 'site-packages', 'torch'),
    path.join(root, '.venv', 'lib', 'site-packages', 'torch'),
    path.join(root, 'venv', 'Lib', 'site-packages', 'torch'),
    path.join(root, 'venv', 'lib', 'site-packages', 'torch')
  ];
  const projectLibs = [path.join(root, '.python', 'lib'), path.join(root, '.venv', 'lib'), path.join(root, 'venv', 'lib')];
  projectLibs.forEach(libDir => {
    try {
      fs.readdirSync(libDir).filter(name => /^python\d/.test(name)).forEach(name => {
        candidates.push(path.join(libDir, name, 'site-packages', 'torch'));
      });
    } catch (_) { /* optional virtualenv */ }
  });
  const direct = candidates.find(validTorchRoot);
  if (direct) return direct;
  const python = findPython(root);
  return python ? pythonTorchRoot(python) : '';
}

function runCommand(command, args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: path.dirname(command), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = data => {
      const text = String(data).trim();
      if (text && log) text.split(/\r?\n/).forEach(line => log('安装器：' + line));
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.on('error', error => reject(new Error('启动 Python 安装器失败：' + error.message)));
    child.on('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error('Python 安装器失败（code=' + code + '，signal=' + (signal || 'none') + '）')));
  });
}

async function ensureTorchRoot(root, log = () => {}) {
  const existing = findTorchRoot(root);
  if (existing) return existing;
  if (process.env.CITADELS_AUTO_INSTALL_TORCH === '0') return '';

  let python = findPython(root);
  const projectPython = process.platform === 'win32'
    ? path.join(root, '.python', 'python.exe')
    : path.join(root, '.python', 'bin', 'python');
  if (!fs.existsSync(projectPython)) {
    const systemPython = python;
    if (!systemPython) throw new Error('未找到 Python，无法自动安装 LibTorch；请安装 python3 或设置 CITADELS_PYTHON');
    log('未找到 LibTorch，正在创建项目 Python 环境：' + projectPython);
    await runCommand(systemPython, ['-m', 'venv', path.join(root, '.python')], log);
  }
  python = resolveCommand(projectPython) || projectPython;
  if (!fs.existsSync(python)) throw new Error('项目 Python 环境创建失败：' + python);

  const packageName = String(process.env.CITADELS_TORCH_PACKAGE || 'torch').trim() || 'torch';
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--prefer-binary', packageName];
  if (process.env.CITADELS_TORCH_INDEX_URL) args.push('--index-url', process.env.CITADELS_TORCH_INDEX_URL);
  log('未找到 LibTorch，开始自动安装 ' + packageName + '：' + python + ' ' + args.join(' '));
  await runCommand(python, args, log);

  const installed = findTorchRoot(root) || pythonTorchRoot(python);
  if (!installed) throw new Error('torch 已安装，但未找到 include/lib；请设置 CITADELS_LIBTORCH 指向 torch 目录');
  log('LibTorch 自动安装完成：' + installed);
  return installed;
}

module.exports = { findCompiler, findPython, findTorchRoot, ensureTorchRoot, resolveCommand, validTorchRoot };
