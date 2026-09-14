'use strict';
// 启动器：从 JSON 配置文件读取训练参数，注入 CITADELS_TRAIN_CONFIG 环境变量后
// 拉起 training/train.js（子进程会按 backend:'gpu' 自动启动 PyTorch CUDA 训练）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const configPath = process.argv[2] || path.join(__dirname, 'gpu-train-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const env = Object.assign({}, process.env, { CITADELS_TRAIN_CONFIG: JSON.stringify(config) });

const child = spawn(process.execPath, [path.join(__dirname, 'train.js')], {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit'
});
child.on('exit', code => { process.exit(code || 0); });
child.on('error', err => { console.error('[launcher] 启动失败:', err.message); process.exit(1); });
