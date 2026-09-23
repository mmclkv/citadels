'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findCompiler, findTorchRoot, ensureTorchRoot } = require('./native-toolchain.js');

function nativeWorkerPath(root, backend = 'libtorch') {
  const suffix = backend === 'libtorch' ? '_libtorch' : '';
  return path.join(root, 'native', 'mcts_worker' + suffix +
    (process.platform === 'win32' ? '.exe' : ''));
}

function newestNativeSourceMtime(root) {
  const dir = path.join(root, 'native');
  let newest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(cpp|cc|hpp|h)$/i.test(name)) continue;
      if (/(_probe|_bench|replay_verify)\.(cpp|cc)$/i.test(name)) continue;
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
    }
  } catch (_) { return 0; }
  return newest;
}

function compileWorker(root, outputFile, backend, log) {
  const compiler = findCompiler();
  if (!compiler) throw new Error('找不到 C++ 编译器：请安装 clang++/g++，或设置 CXX/LLVM_ROOT');
  const source = path.join(root, 'native', 'mcts_worker.cpp');
  const tempFile = outputFile + '.tmp-' + process.pid;
  // libtorch.h 的模板实例化在低内存 Linux 主机上会让 cc1plus 被 OOM killer
  // 杀掉。原生 worker 以搜索吞吐换取可部署性，默认使用 O0；需要更高优化时
  // 可通过 CITADELS_LIBTORCH_OPT_LEVEL=-O1/-O2 显式调整。
  const optimization = backend === 'libtorch'
    ? (process.env.CITADELS_LIBTORCH_OPT_LEVEL || '-O0')
    : '-O2';
  const args = ['-std=c++20', optimization, '-I', path.join(root, 'native')];
  const linkArgs = [];
  let runtimePath = '';
  if (backend === 'libtorch') {
    const torchRoot = findTorchRoot(root);
    if (!torchRoot) throw new Error('未找到 LibTorch：请设置 CITADELS_LIBTORCH，或在项目虚拟环境/python3 中安装 torch');
    const include = path.join(torchRoot, 'include');
    const apiInclude = path.join(include, 'torch', 'csrc', 'api', 'include');
    const lib = path.join(torchRoot, 'lib');
    args.push('-DCITADELS_LIBTORCH', '-I', include, '-I', apiInclude);
    linkArgs.push('-L', lib, '-ltorch', '-ltorch_cpu', '-lc10');
    if (process.platform !== 'win32') linkArgs.push('-Wl,-rpath,' + lib);
    runtimePath = lib;
  }
  args.push(source, '-o', tempFile, ...linkArgs);
  if (process.platform === 'win32') args.push('-ldbghelp');
  log('开始编译 ' + path.basename(outputFile) + '：' + compiler + ' ' + args.join(' '));
  return new Promise((resolve, reject) => {
    const child = spawn(compiler, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = data => {
      const text = String(data).trim();
      if (text) log('编译器：' + text);
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.on('error', error => reject(new Error('启动 C++ 编译器失败：' + error.message)));
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        try { fs.rmSync(tempFile, { force: true }); } catch (_) { /* best effort */ }
        return reject(new Error('编译 ' + path.basename(outputFile) + ' 失败（code=' + code + ', signal=' + (signal || 'none') + '）'));
      }
      try { fs.renameSync(tempFile, outputFile); }
      catch (error) { return reject(new Error('替换 ' + path.basename(outputFile) + ' 失败：' + error.message)); }
      if (process.platform !== 'win32') {
        try { fs.chmodSync(outputFile, 0o755); }
        catch (error) { return reject(new Error('设置 ' + path.basename(outputFile) + ' 可执行权限失败：' + error.message)); }
      }
      resolve({ outputFile, runtimePath });
    });
  });
}

class NativeWorkerManager {
  constructor({ root, backend = 'libtorch', log = console.log } = {}) {
    this.root = root;
    this.backend = backend;
    this.log = log;
    this.executable = nativeWorkerPath(root, backend);
    this.runtimePath = '';
    this.child = null;
    this.startPromise = null;
  }

  async ensureBuilt() {
    const builtAt = fs.existsSync(this.executable) ? fs.statSync(this.executable).mtimeMs : 0;
    const sourceAt = newestNativeSourceMtime(this.root);
    if (this.backend === 'libtorch' && (!builtAt || sourceAt > builtAt)) {
      await ensureTorchRoot(this.root, text => this.log('[native] ' + text));
    }
    if (!builtAt || sourceAt > builtAt) {
      this.log(!builtAt ? '未找到 ' + path.basename(this.executable) + '，开始编译' :
        '检测到 native/ 源码更新，重新编译 ' + path.basename(this.executable));
      const result = await compileWorker(this.root, this.executable, this.backend, this.log);
      this.runtimePath = result.runtimePath;
    } else {
      this.log('已找到 ' + path.basename(this.executable) + '，源码未更新，跳过编译');
      if (process.platform !== 'win32') {
        try { fs.chmodSync(this.executable, 0o755); }
        catch (error) { throw new Error('设置 mcts_worker 可执行权限失败：' + error.message); }
      }
      if (this.backend === 'libtorch') {
        const torchRoot = findTorchRoot(this.root);
        this.runtimePath = torchRoot ? path.join(torchRoot, 'lib') : '';
      }
    }
    return this.executable;
  }

  spawnChild() {
    const env = { ...process.env };
    if (this.runtimePath) {
      env.PATH = this.runtimePath + path.delimiter + (env.PATH || '');
      if (process.platform !== 'win32') {
        env.LD_LIBRARY_PATH = this.runtimePath + path.delimiter + (env.LD_LIBRARY_PATH || '');
      }
    }
    this.child = spawn(this.executable, [], { cwd: this.root, env, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', data => {
      const text = String(data).trim(); if (text) this.log('mcts_worker：' + text);
    });
    this.child.on('error', error => this.log('mcts_worker 启动失败：' + error.message));
    this.child.on('exit', (code, signal) => {
      if (this.child && this.child.exitCode != null) this.log('mcts_worker 已退出（code=' + code + '，signal=' + (signal || 'none') + '）');
    });
    this.log('mcts_worker 已启动：' + this.executable + '（PID ' + this.child.pid + '）');
    return this.child;
  }

  restartSync() {
    this.close();
    if (!this.runtimePath && this.backend === 'libtorch') {
      const torchRoot = findTorchRoot(this.root);
      this.runtimePath = torchRoot ? path.join(torchRoot, 'lib') : '';
    }
    return this.spawnChild();
  }

  async start({ build = true } = {}) {
    if (this.child && this.child.exitCode == null) return this.child;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (build) {
        await this.ensureBuilt();
      } else {
        if (!fs.existsSync(this.executable)) {
          throw new Error('未找到已编译的 mcts_worker：' + this.executable);
        }
        if (process.platform !== 'win32') {
          try { fs.chmodSync(this.executable, 0o755); }
          catch (error) { throw new Error('设置 mcts_worker 可执行权限失败：' + error.message); }
        }
        if (this.backend === 'libtorch') {
          const torchRoot = findTorchRoot(this.root);
          this.runtimePath = torchRoot ? path.join(torchRoot, 'lib') : '';
        }
        this.log('跳过编译，直接启动已有 ' + path.basename(this.executable));
      }
      return this.spawnChild();
    })().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async restart() {
    this.close();
    return this.start();
  }

  close() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode != null) return;
    if (process.platform === 'win32') {
      // worker 本身不再派生需要单独清理的子进程时，直接终止由 Node 管理的进程最可靠；
      // 某些受限环境下 taskkill 会返回“拒绝访问”，不能只依赖它。
      try { child.kill(); } catch (_) { /* fallback */ }
      if (child.exitCode == null) {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch (_) { /* already exiting */ }
      }
      return;
    }
    try { child.kill(); } catch (_) { /* already exited */ }
  }
}

module.exports = { NativeWorkerManager, nativeWorkerPath, newestNativeSourceMtime, findCompiler, findTorchRoot };
