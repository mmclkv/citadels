/* 暗夜赛博霓虹-女性力量主题资源完整性检查：角色按 id、建筑按英文 key，full/thumb 均必须存在。 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Cards = require('../src/cards.js');

const root = path.join(__dirname, '..');
const manifestCode = fs.readFileSync(path.join(root, 'public', 'themes', 'neon', 'manifest.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(manifestCode, sandbox, { filename: 'manifest.js' });
const manifest = sandbox.CitadelThemeManifests && sandbox.CitadelThemeManifests.neon;
if (!manifest) throw new Error('找不到 neon 主题 manifest');

function assetPath(relative) { return path.join(root, 'public', relative.replace(/^\.\//, '')); }
function safeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function checkEntry(label, entry) {
  ['thumb', 'full'].forEach(variant => {
    if (!entry || !entry[variant]) throw new Error(label + ' 缺少 ' + variant + ' 路径');
    const filename = assetPath(entry[variant]);
    if (!fs.existsSync(filename)) throw new Error(label + ' 缺少文件：' + entry[variant]);
    const stat = fs.statSync(filename);
    if (!stat.size) throw new Error(label + ' 文件为空：' + entry[variant]);
    if (path.extname(filename).toLowerCase() !== '.webp') throw new Error(label + ' 不是 WebP：' + entry[variant]);
  });
}

Cards.CHARACTERS.forEach(c => checkEntry('角色 ' + c.id, manifest.cards.roles[c.id]));
Cards.DISTRICTS.forEach(d => {
  const key = 'district_' + safeKey(d.en || d.name);
  checkEntry('建筑 ' + d.name + ' [' + key + ']', manifest.cards.districts[key]);
});

const roleKeys = Object.keys(manifest.cards.roles);
const districtKeys = Object.keys(manifest.cards.districts);
if (roleKeys.length !== Cards.CHARACTERS.length) throw new Error('角色 manifest 数量不匹配');
if (districtKeys.length !== Cards.DISTRICTS.length) throw new Error('建筑 manifest 数量不匹配');

console.log('✓ neon 资源完整：' + roleKeys.length + ' 个角色 × 2，' + districtKeys.length + ' 个建筑 × 2');
