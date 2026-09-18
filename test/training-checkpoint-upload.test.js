'use strict';
// 回归：训练控制台「继续已有训练」只有两个选项 —— 从头训练 / 加载权重继续训练，
// 选后者弹出系统文件管理器，选中的权重文件上传进 training-data 当成普通存档续训。
//
// 链路：public/training.js（选文件 → 上传）→ POST /api/training/checkpoint/upload
//      → lib/training-manager.js 的 importCheckpoint() → 落成 checkpoint-*.json.gz
//      → start() 的 resumeCheckpoint 校验（只认 checkpoint-[\w-]+.json.gz）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { createTrainingManager } = require('../lib/training-manager.js');
const CHECKPOINT_NAME = /^checkpoint-[\w-]+\.json\.gz$/;   // 与 training-manager.start() 的校验同式

function withTempManager(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-ckpt-upload-'));
  try {
    const dataDir = path.join(dir, 'training-data');
    fs.mkdirSync(dataDir, { recursive: true });
    return fn(createTrainingManager({ root: dir }), dataDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function gzCheckpoint(game = 192) {
  return zlib.gzipSync(JSON.stringify({
    createdAt: '2026-09-19T00:00:00.000Z', game,
    config: { targetGames: 1000, profile: 'large' },
    model: { w: [1, 2, 3] }
  }));
}

test('导入合法权重：落地为合法存档名，内容原样保留', () => {
  withTempManager((manager, dataDir) => {
    const bytes = gzCheckpoint(192);
    const result = manager.importCheckpoint('checkpoint-000192-plarge.json.gz', bytes);
    assert.match(result.name, CHECKPOINT_NAME, '名字必须能过 start() 的校验：' + result.name);
    assert.strictEqual(result.name, 'checkpoint-000192-plarge.json.gz', '本来合法的名字不应该被改写');
    assert.strictEqual(result.renamed, false);
    assert.strictEqual(result.game, 192, '回传已训局数给面板展示');
    assert.ok(fs.existsSync(path.join(dataDir, result.name)), '文件要真的落盘');
    assert.deepStrictEqual(fs.readFileSync(path.join(dataDir, result.name)), bytes,
      '原样写入收到的字节（它已经是 gzip 了，不该再压一遍）');
  });
});

test('导入时会把中文 / 空格 / 路径穿越的文件名洗成合法存档名', () => {
  withTempManager((manager, dataDir) => {
    const cases = ['我的 权重.json.gz', '../../../evil.json.gz', 'model.pt.gz', ''];
    for (const original of cases) {
      const result = manager.importCheckpoint(original, gzCheckpoint(7));
      assert.match(result.name, CHECKPOINT_NAME,
        '「' + original + '」洗出来的名字 ' + result.name + ' 过不了 start() 的校验');
      assert.strictEqual(path.dirname(path.join(dataDir, result.name)), dataDir,
        '名字里不能带路径成分（防穿越）');
      assert.ok(fs.existsSync(path.join(dataDir, result.name)));
    }
  });
});

test('同名文件不覆盖已有存档', () => {
  withTempManager((manager, dataDir) => {
    const first = manager.importCheckpoint('same.json.gz', gzCheckpoint(1));
    const second = manager.importCheckpoint('same.json.gz', gzCheckpoint(2));
    assert.notStrictEqual(second.name, first.name, '第二次要换一个名字');
    assert.match(second.name, CHECKPOINT_NAME);
    assert.strictEqual(
      JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, first.name))).toString('utf8')).game, 1,
      '已有存档不能被后来的同名文件覆盖');
  });
});

test('不是本项目存档的文件要给出可读错误，且不落盘', () => {
  withTempManager((manager, dataDir) => {
    assert.throws(() => manager.importCheckpoint('x.json.gz', Buffer.alloc(0)), /文件是空的/);
    assert.throws(() => manager.importCheckpoint('x.json.gz', Buffer.from('plain text')), /无法解析/);
    assert.throws(
      () => manager.importCheckpoint('x.json.gz', zlib.gzipSync(JSON.stringify({ game: 1 }))),
      /没有模型权重/, '只有 config 没有 model 的旧存档不能用来续训');
    assert.deepStrictEqual(fs.readdirSync(dataDir), [], '失败的导入不能留下垃圾文件');
  });
});

test('服务端有上传接口，且只接受本机请求', () => {
  const server = read('server.js');
  assert.match(server, /pathname === '\/api\/training\/checkpoint\/upload' && req\.method === 'POST'/,
    '需要 POST /api/training/checkpoint/upload');
  assert.match(server, /trainingManager\.importCheckpoint\(/, '路由调用 trainingManager.importCheckpoint');
  assert.match(server, /readRawBody\(req, CHECKPOINT_UPLOAD_LIMIT\)/, '上传必须有体积上限，不能无缓冲地收');
  const route = server.match(/if \(pathname === '\/api\/training\/checkpoint\/upload'[\s\S]*?\n  \}/);
  assert.ok(route, '必须能读到上传路由');
  assert.match(route[0], /isLoopback\(req\)/, '上传必须沿用本机限制');
});

test('面板上「继续已有训练」只剩两个选项，选第二个会弹文件管理器', () => {
  const html = read('public/training.html');
  assert.match(html, /id="resume-checkpoint"/, '下拉框本身还在（CONFIG_FIELDS 之外的回填数据源）');
  assert.match(html, /id="resume-checkpoint-file"/, '要有隐藏的文件选择框用来弹出资源管理器');
  assert.match(html, /id="resume-checkpoint-name"/, '要有隐藏域登记上传后的存档名');

  const js = read('public/training.js');
  const modes = js.match(/const RESUME_MODES = ([\s\S]*?);\n/);
  assert.ok(modes, '两个选项集中在 RESUME_MODES 里定义');
  assert.match(modes[1], /value=""[^>]*>从头训练/, '第一个选项是「从头训练」');
  assert.match(modes[1], /value="file"[^>]*>加载权重继续训练/, '第二个选项是「加载权重继续训练」');
  assert.doesNotMatch(modes[1], /item\.name|list\.map/, '不再往下拉框里塞服务器上的存档列表');

  const pick = js.match(/function requestCheckpointFile\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(pick, '必须定义 requestCheckpointFile()');
  assert.match(pick[0], /picker\.click\(\)/, '要真的触发文件选择框（才会弹出资源管理器）');
  assert.match(js, /\/api\/training\/checkpoint\/upload\?name=/, '选完要上传到服务端');
  assert.match(js, /\$\('resume-checkpoint'\)\.addEventListener\('change'/, '切换选项要接上弹窗/清理逻辑');

  // 取消选择不能留下「选了模式但没文件」的半吊子配置
  const upload = js.match(/async function uploadCheckpointFile\(file\)\s*\{[\s\S]*?\n\}/);
  assert.ok(upload, '必须定义 uploadCheckpointFile()');
  assert.match(upload[0], /\$\('resume-checkpoint-name'\)\.value = ''/, '上传失败要退回从头训练');
});

test('formConfig 提交的 resumeCheckpoint 来自隐藏域，而不是下拉框的值', () => {
  const js = read('public/training.js');
  const form = js.match(/function formConfig\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(form, '必须能读到 formConfig()');
  assert.match(form[0], /resumeCheckpoint: resumeCheckpointName\(\)/,
    '下拉框的值是 ""/"file" 两种模式，真正的存档名在隐藏域里');

  const helper = js.match(/function resumeCheckpointName\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(helper, '必须定义 resumeCheckpointName()');
  assert.match(helper[0], /=== 'file'/, '只有「加载权重继续训练」模式才带存档名');
});

console.log('训练控制台「加载权重继续训练」：文件选择、上传、命名清洗与面板接线全部通过');
