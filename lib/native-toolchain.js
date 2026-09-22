'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

module.exports = { findCompiler, findPython, findTorchRoot, resolveCommand, validTorchRoot };
