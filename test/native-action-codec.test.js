'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('C++ 动作类型映射覆盖 JS 引擎全部动作', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'native', 'action_codec.hpp'), 'utf8');
  const jsTypes = [...fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8')
    .matchAll(/type:\s*'([^']+)'/g)].map(match => match[1]);
  for (const type of new Set(jsTypes)) assert.match(source, new RegExp(`\\"${type}\\"`));
  assert.equal(new Set(jsTypes).size, 39);
});

test('C++ 动作 codec 头文件可独立编译', () => {
  const clang = process.env.CITADELS_CLANGXX;
  if (!clang || !fs.existsSync(clang)) {
    assert.ok(true, '未设置 CITADELS_CLANGXX，跳过编译检查');
    return;
  }
  const result = execFileSync(clang, ['-std=c++17', '-x', 'c++', '-fsyntax-only', '-'], {
    input: '#include "native/action_codec.hpp"\nint main() { return 0; }\n',
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.equal(result, '');
});
