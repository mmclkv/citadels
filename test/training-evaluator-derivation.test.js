'use strict';
// 回归：JS MCTS 已删除，训练页和服务端只允许 C++ MCTS。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('训练页不再有「神经网络评估器」选项', () => {
  const html = read('public/training.html');
  assert.doesNotMatch(html, /神经网络评估器/, '下拉框标签应已删除');
  assert.doesNotMatch(html, /id="mcts-evaluator"/, 'mcts-evaluator select 应已删除');
  assert.doesNotMatch(html, /id="mcts-evaluator-hint"/, '旧提示位应已删除');
  assert.match(html, /option value="cpp" disabled>C\+\+（尚未支持完整规则）/, '未完成的 C++ 规则引擎应禁用');
});

test('前端不再残留任何对旧选项的引用', () => {
  const js = read('public/training.js');
  assert.doesNotMatch(js, /mcts-evaluator/, '不应再有 $(\'mcts-evaluator\') 之类的引用');
});

test('评估器由神经网络框架 + MCTS 引擎推导，规则与服务端一致', () => {
  const js = read('public/training.js');
  const fn = js.match(/function resolveMctsEvaluator\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, '必须定义 resolveMctsEvaluator()');
  assert.match(fn[0], /return 'gpu'/, 'C++ MCTS 统一走原生网络评估');
  // 推导函数必须真的被用于提交配置，而不是另写一份
  assert.match(js, /mctsEvaluator:\s*resolveMctsEvaluator\(\)/, 'formConfig 必须使用推导值');
});

test('推导规则与 train.js 的 sanitizeConfig 保持同构', () => {
  const train = read('training/train.js');
  assert.match(train, /const mctsEngine = 'cpp'/, '服务端必须固定使用 C++ MCTS');
});

test('原提示信息迁移到「神经网络框架」下方并仍会随选择刷新', () => {
  const html = read('public/training.html');
  assert.match(html, /id="neural-framework-hint"/, '提示位应挂在神经网络框架上');
  const js = read('public/training.js');
  assert.match(js, /\$\('neural-framework-hint'\)\.textContent = framework/, '提示文案仍需按网络框架刷新');
  assert.match(js, /LibTorch 评估/, 'C++ + LibTorch 的提示文案要保留');
});

test('切换框架会刷新单步耗时估算（评估器变了，估算口径也变）', () => {
  const js = read('public/training.js');
  const fn = js.match(/function updateMctsEvaluatorUI\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, '必须定义 updateMctsEvaluatorUI()');
  assert.match(fn[0], /estimateMCTS\(\)/, '框架切换后要重算单步估算');
  assert.match(js, /\$\('neural-network-framework'\)\.onchange = updateMctsEvaluatorUI/,
    '框架变更必须绑定刷新');
});

test('训练页静态资源版本号已推进（浏览器才会加载新文件）', () => {
  const html = read('public/training.html');
  const js = Number((html.match(/training\.js\?v=(\d+)/) || [])[1]);
  assert.ok(js >= 12, 'training.js 版本号需推进，当前 ' + js);
});
