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

function pythonTorchRoot(python, extraPath = '') {
  const probe = spawnSync(python, ['-c',
    'import os, torch; print(os.path.dirname(torch.__file__))'],
  { encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: extraPath ? { ...process.env, PYTHONPATH: extraPath + path.delimiter + (process.env.PYTHONPATH || '') } : process.env });
  if (probe.status !== 0) return '';
  const item = String(probe.stdout || '').trim().split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return validTorchRoot(item) ? item : '';
}

function usablePython(python) {
  if (!python) return false;
  const probe = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  return probe.status === 0;
}

function hasPythonModule(python, moduleName) {
  if (!usablePython(python)) return false;
  const probe = spawnSync(python, ['-c', 'import ' + moduleName], {
    encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  return probe.status === 0;
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
    if (resolved && usablePython(resolved)) return resolved;
  }
  return '';
}

function findSystemPython() {
  const candidates = [process.env.PYTHON, process.env.CITADELS_PYTHON,
    process.platform === 'win32' ? 'python' : 'python3', 'python'].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate);
    if (resolved && usablePython(resolved)) return resolved;
  }
  return '';
}

function findTorchRoot(root) {
  const explicit = process.env.CITADELS_LIBTORCH;
  if (validTorchRoot(explicit)) return explicit;
  const candidates = [
    path.join(root, '.python', 'Lib', 'site-packages', 'torch'),
    path.join(root, '.python', 'lib', 'site-packages', 'torch'),
    path.join(root, '.python-packages', 'torch'),
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
    let lastOutput = '';
    const child = spawn(command, args, { cwd: path.dirname(command), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = data => {
      const text = String(data).trim();
      if (text) lastOutput = text.split(/\r?\n/).pop();
      if (text && log) text.split(/\r?\n/).forEach(line => log('安装器：' + line));
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.on('error', error => reject(new Error('启动 Python 安装器失败：' + error.message)));
    child.on('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error('Python 安装器失败（code=' + code + '，signal=' + (signal || 'none') + '）：' + (lastOutput || '无额外输出'))));
  });
}

async function tryInstallPythonSystemDependencies(log) {
  if (process.platform === 'win32') return false;
  const apt = resolveCommand('apt-get');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const explicitlyEnabled = process.env.CITADELS_AUTO_INSTALL_SYSTEM_DEPS === '1';
  if (!apt || (!isRoot && !explicitlyEnabled)) return false;
  log('检测到 Linux Python 缺少 venv/pip，正在自动安装系统依赖：python3-venv、python3-pip');
  await runCommand(apt, ['install', '-y', 'python3-venv', 'python3-pip'], log);
  return true;
}

async function ensureTorchRoot(root, log = () => {}) {
  const existing = findTorchRoot(root);
  if (existing) return existing;
  if (process.env.CITADELS_AUTO_INSTALL_TORCH === '0') return '';

  let python = findPython(root);
  const systemPython = findSystemPython();
  const projectPython = process.platform === 'win32'
    ? path.join(root, '.python', 'python.exe')
    : path.join(root, '.python', 'bin', 'python');
  let targetPath = '';
  if (!usablePython(projectPython)) {
    if (!systemPython) throw new Error('未找到可用 Python，无法自动安装 LibTorch；请安装 python3 或设置 CITADELS_PYTHON');
    log('未找到 LibTorch，正在创建项目 Python 环境：' + projectPython);
    try {
      await runCommand(systemPython, ['-m', 'venv', path.join(root, '.python')], log);
    } catch (error) {
      let venvReady = false;
      try {
        if (await tryInstallPythonSystemDependencies(log)) {
          await runCommand(systemPython, ['-m', 'venv', path.join(root, '.python')], log);
          venvReady = usablePython(projectPython);
        }
      } catch (dependencyError) {
        log('自动安装 Linux Python 依赖失败：' + dependencyError.message);
      }
      if (venvReady) {
        log('Linux Python 依赖已补齐，项目 Python 环境创建完成');
      } else {
      // Debian/Ubuntu 的精简 Python 常常没有 ensurepip，不能让整个 server 启动流程
      // 在这里失败。改用项目隔离目录安装，避免污染系统 site-packages。
      targetPath = path.join(root, '.python-packages');
      log('项目 Python 环境创建失败：' + error.message);
      log('检测到可能缺少 python3-venv，回退到项目隔离目录：' + targetPath);
      log('如需启用虚拟环境，请管理员执行：sudo apt-get install -y python3-venv');
      python = systemPython;
      }
    }
  }
  if (!targetPath) {
    python = resolveCommand(projectPython) || projectPython;
    if (!usablePython(python)) throw new Error('项目 Python 环境创建失败，且无法使用系统 Python：' + python);
    if (!hasPythonModule(python, 'pip')) {
      log('项目 Python 环境缺少 pip，无法直接安装 torch');
      let systemPipReady = systemPython && hasPythonModule(systemPython, 'pip');
      if (!systemPipReady) {
        try {
          if (await tryInstallPythonSystemDependencies(log)) {
            systemPipReady = hasPythonModule(systemPython, 'pip');
          }
        } catch (error) {
          log('自动补齐 Python pip 失败：' + error.message);
        }
      }
      if (!systemPipReady) {
        throw new Error('项目 Python 没有 pip，且系统 Python 也没有 pip；请安装 python3-pip 和 python3-venv，或设置 CITADELS_LIBTORCH');
      }
      targetPath = path.join(root, '.python-packages');
      python = systemPython;
      log('回退到系统 Python + 项目隔离目录：' + targetPath);
    }
  }

  const packageName = String(process.env.CITADELS_TORCH_PACKAGE || 'torch').trim() || 'torch';
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--prefer-binary'];
  if (targetPath) args.push('--target', targetPath);
  args.push(packageName);
  if (process.env.CITADELS_TORCH_INDEX_URL) args.push('--index-url', process.env.CITADELS_TORCH_INDEX_URL);
  log('未找到 LibTorch，开始自动安装 ' + packageName + '：' + python + ' ' + args.join(' '));
  try {
    await runCommand(python, args, log);
  } catch (error) {
    if (targetPath && /No module named pip|No module named ["']?pip/.test(error.message)) {
      throw new Error('系统 Python 没有 pip，无法自动安装 LibTorch；请安装 python3-pip 和 python3-venv，或设置 CITADELS_LIBTORCH');
    }
    throw error;
  }

  const installed = findTorchRoot(root) || pythonTorchRoot(python, targetPath);
  if (!installed) throw new Error('torch 已安装，但未找到 include/lib；请设置 CITADELS_LIBTORCH 指向 torch 目录');
  log('LibTorch 自动安装完成：' + installed);
  return installed;
}

module.exports = { findCompiler, findPython, findSystemPython, findTorchRoot, ensureTorchRoot, resolveCommand, validTorchRoot };
