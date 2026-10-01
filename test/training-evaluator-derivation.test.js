'use strict';
// 回归：生产训练控制台呈现 Python runtime 的真实能力，不暴露旧 C++ worker 设置。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('训练页固定展示 Python 规则、Python ISMCTS 与 PyTorch，不保留伪下拉框', () => {
  const html = read('public/training.html');
  assert.match(html, /class="fixed-setting">Python</, '规则引擎应明确为 Python');
  assert.match(html, /class="fixed-setting">Python ISMCTS</, '搜索引擎应明确为 Python');
  assert.match(html, /class="fixed-setting">PyTorch</, '训练模型使用 PyTorch');
  assert.doesNotMatch(html, /id="(?:rules-engine|mcts-engine|neural-network-framework)"/,
    '固定后端不应伪装成可切换下拉框');
  assert.doesNotMatch(html, /id="mcts-(batch-size|max-wait|cache-size)"/, '不应暴露未实现的 C++ evaluator 参数');
});

test('前端不再残留任何对旧选项的引用', () => {
  const js = read('public/training.js');
  assert.doesNotMatch(js, /mcts-evaluator|mctsEvaluator|nativeInferenceBackend|nativeSearchWorker/,
    '前端不应残留旧 evaluator/worker 配置');
});

test('提交配置明确使用 Python/PyTorch，不透传旧引擎配置', () => {
  const js = read('public/training.js');
  const fn = js.match(/function formConfig\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, '必须定义 formConfig()');
  assert.match(fn[0], /rulesEngine:\s*'python'/);
  assert.match(fn[0], /mctsEngine:\s*'python'/);
  assert.match(fn[0], /neuralNetworkFramework:\s*'pytorch'/);
  assert.match(fn[0], /backend:\s*'python'/);
  assert.doesNotMatch(fn[0], /mctsEvaluator|nativeInferenceBackend|nativeSearchWorker/);
});

test('框架说明准确描述 Python ISMCTS 与 PyTorch', () => {
  const html = read('public/training.html');
  assert.match(html, /id="neural-framework-hint"/, '提示位应挂在神经网络框架上');
  const js = read('public/training.js');
  assert.match(js, /Python ISMCTS 使用当前 PyTorch 训练模型/, '提示必须反映实际评估路径');
});

test('变更自对弈条件时刷新 Python MCTS 提示和耗时估算', () => {
  const js = read('public/training.js');
  const fn = js.match(/function updateMctsHint\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, '必须定义 updateMctsHint()');
  assert.match(fn[0], /estimateMCTS\(\)/, '框架切换后要重算单步估算');
  assert.match(js, /\$\('char-set'\)\.onchange = updateMctsHint/);
  assert.match(js, /\$\('device'\)\.onchange = updateMctsHint/);
});

test('训练页静态资源版本号已推进（浏览器才会加载新文件）', () => {
  const html = read('public/training.html');
  const js = Number((html.match(/training\.js\?v=(\d+)/) || [])[1]);
  assert.ok(js >= 27, 'training.js 版本号需推进，当前 ' + js);
  const css = Number((html.match(/training\.css\?v=(\d+)/) || [])[1]);
  assert.ok(css >= 12, 'training.css 版本号需推进，当前 ' + css);
});
