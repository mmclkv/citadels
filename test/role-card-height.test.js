/* 选角牌池「除了刺客其他牌都偏短」的回归测试。
 *
 * 背景：霓虹主题的角色卡是整张卡图（编号/名称/规则/按钮都画在图里），而卡图源文件
 * 比例并不统一：
 *   多数角色 280×420（2:3）
 *   刺客     280×469   ← 最高
 *   贵族     280×459
 *   商人     280×396   ← 最矮
 * .cc-art 原本是 img{width:100%;height:auto} 按原比例自适应高度，而 .draft-pool 是
 * flex（默认 align-items:stretch），于是外层 .char-card 被拉到最高那张的高度、内层
 * 卡图却只占自己那一截 —— 结果同一排里除了刺客以外每张牌下面都空出一条，看起来就是
 * 「其他牌比刺客短一截」。158px 宽的卡在截图上差 26px（222 vs 248），与用户截图一致。
 *
 * 修复：霓虹主题里把 .cc-art 固定成最高那张的比例（--role-card-ratio: 280/469），
 * 图片 cover 填满，出框的只是卡图外缘一圈留白，卡面文字与按钮栏都保留。
 *
 * 本测试用纯 Node 解析 WebP 头部读真实像素尺寸，不依赖任何图形库，锁住的不变量：
 *   1. 素材比例确实不齐（防止场景写错 / 素材被换成整齐的之后本测试失去意义）
 *   2. 修复后所有角色卡的卡图框高度完全一致
 *   3. --role-card-ratio 不低于最高那张素材（保证拍板：任何一张都不会被纵向裁掉内容）
 *   4. 图片用 cover 填充，不会出现上下留白
 *   5. 底部「本轮出局角色」小卡的固定宽高规则没被顶掉（那是个例外，必须保持原样）
 *   6. 角色一览的角色卡同样对齐，且没有波及比例本来就齐的建筑卡图
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const neonCss = fs.readFileSync(path.join(root, 'public', 'themes', 'neon', 'theme.css'), 'utf8');
const baseCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

let pass = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  pass++;
  console.log('  ✓ ' + label);
}

/* ---------------- WebP 头部解析（VP8 / VP8L / VP8X） ---------------- */
function webpSize(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error(file + ' 不是 WebP');
  }
  const fourcc = b.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  }
  if (fourcc === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8 ') {
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  throw new Error(file + ' 未知 WebP 类型 ' + fourcc);
}

const thumbDir = path.join(root, 'public', 'assets', 'themes', 'neon', 'cards', 'roles', 'thumb');
const thumbs = fs.readdirSync(thumbDir).filter(f => f.endsWith('.webp')).map(f => {
  const size = webpSize(path.join(thumbDir, f));
  return { name: f.replace('.webp', ''), w: size.w, h: size.h, ratio: size.w / size.h };
}).sort((a, b) => a.ratio - b.ratio);

/* ---------------- 1. 素材比例确实不齐 ---------------- */
const thinnest = thumbs[0];                     // 比例最小 = 最高
const widest = thumbs[thumbs.length - 1];       // 比例最大 = 最矮
ok(thumbs.length >= 8, '读到 ' + thumbs.length + ' 张霓虹角色卡图');
ok(thinnest.name === 'assassin', '最高的一张是刺客（' + thinnest.w + '×' + thinnest.h + '，比例 ' +
  thinnest.ratio.toFixed(4) + '）');
ok(widest.ratio - thinnest.ratio > 0.08,
  '素材比例不齐：最矮的 ' + widest.name + ' ' + widest.ratio.toFixed(4) +
  ' vs 最高的刺客 ' + thinnest.ratio.toFixed(4) + '，相差 ' +
  ((widest.ratio / thinnest.ratio - 1) * 100).toFixed(1) + '%');
const count2x3 = thumbs.filter(t => Math.abs(t.ratio - 2 / 3) < 0.005).length;
ok(count2x3 === thumbs.length - 3, '其中 ' + count2x3 + ' 张是标准 2:3，另外 3 张是刺客/贵族/商人');

/* ---------------- 2. 复现症状：按原比例自适应高度时长度不齐 ---------------- */
// .char-card 宽 158、边框 1px、内边距 5px（box-sizing:border-box）→ 卡图可用宽 146
const ART_W = 158 - 2 * 1 - 2 * 5;
const autoHeights = thumbs.map(t => ({ name: t.name, h: ART_W / t.ratio }));
const tallest = autoHeights.slice().sort((a, b) => b.h - a.h)[0];
ok(tallest.name === 'assassin', '不修复时最高的仍是刺客（' + tallest.h.toFixed(1) + 'px）');
const shortOnes = autoHeights.filter(a => a.name !== 'assassin');
const gap = tallest.h - Math.min.apply(null, shortOnes.map(a => a.h));
ok(gap > 20, '不修复时最长与最短相差 ' + gap.toFixed(1) + 'px（' + ART_W + 'px 宽的卡图框），' +
  '就是用户看到的「其他牌偏短」');
ok(shortOnes.every(a => a.h <= tallest.h), '不修复时除刺客外每一张都比刺客短');

/* ---------------- 3. CSS 把卡图框钉成同一高度 ---------------- */
const ratioDecl = /--role-card-ratio\s*:\s*([\d.]+)\s*\/\s*([\d.]+)\s*;/.exec(neonCss);
ok(!!ratioDecl, '霓虹主题定义了 --role-card-ratio');
const declared = Number(ratioDecl[1]) / Number(ratioDecl[2]);
ok(Math.abs(declared - thinnest.ratio) < 0.002,
  '--role-card-ratio（' + declared.toFixed(4) + '）等于最高的那张素材（' +
  thinnest.ratio.toFixed(4) + '）');
ok(declared <= thinnest.ratio + 1e-6,
  '统一比例不高于任何一张素材 → 没有任何一张会被纵向裁掉内容');

const artRule = /html\[data-theme="neon"\]\s*\.char-card\.neon-role-card\s*\.cc-art\s*\{([^}]*)\}/.exec(neonCss);
ok(!!artRule, '找到 .char-card.neon-role-card .cc-art 规则');
ok(/aspect-ratio\s*:\s*var\(--role-card-ratio\)/.test(artRule[1]),
  '卡图框用 aspect-ratio:var(--role-card-ratio) 定高');
ok(!/(^|[^-])\bwidth\s*:/.test(artRule[1]) && !/(^|[^-])\bheight\s*:/.test(artRule[1]),
  '卡图框只定比例、不写死宽高 → 固定尺寸的小卡（出局角色）仍按自己的宽高走');
ok(/overflow\s*:\s*hidden/.test(baseCss.split('.char-card .cc-art')[1].split('}')[0]),
  '基类 .cc-art 有 overflow:hidden，出框部分被裁掉而不是溢出');

const imgRule = /html\[data-theme="neon"\]\s*\.char-card\.neon-role-card\s*\.cc-art\s+img\s*\{([^}]*)\}/.exec(neonCss);
ok(!!imgRule, '找到卡图 img 规则');
ok(/object-fit\s*:\s*cover/.test(imgRule[1]),
  '卡图 object-fit:cover 填满 → 不出现上下留白（对照：contain 会留边）');
ok(/height\s*:\s*100%/.test(imgRule[1]), '卡图 height:100% 撑满定高后的卡图框');

const fixedHeights = thumbs.map(t => ({ name: t.name, h: ART_W / declared }));
ok(fixedHeights.every(x => Math.abs(x.h - fixedHeights[0].h) < 1e-9),
  '修复后所有角色卡图框高度完全一致（' + fixedHeights[0].h.toFixed(1) + 'px）');
ok(Math.abs(fixedHeights[0].h - tallest.h) < 0.5,
  '统一高度等于原来最高那张（' + tallest.h.toFixed(1) + 'px）→ 只有变长的、没有变短的');

/* ---------------- 4. 选角蓝框紧贴卡图 ---------------- */
const draftTightRule = /html\[data-theme="neon"\]\s*#screen-game\.draft-phase\s*#draft-pool\s*\.char-card\.neon-role-card\s*\{([^}]*)\}/.exec(baseCss);
ok(!!draftTightRule && /padding\s*:\s*0\s*!important/.test(draftTightRule[1]),
  '选角牌外层蓝框没有内边距，边框紧贴卡图');
const draftImgRule = /html\[data-theme="neon"\]\s*#screen-game\.draft-phase\s*#draft-pool\s*\.char-card\.neon-role-card\s*\.cc-art\s+img\s*\{([^}]*)\}/.exec(baseCss);
ok(!!draftImgRule && /height\s*:\s*100%\s*!important/.test(draftImgRule[1]) &&
  /max-height\s*:\s*none\s*!important/.test(draftImgRule[1]),
  '选角卡图撑满蓝框，并覆盖 PC 紧凑布局的 120px 高度上限');

/* ---------------- 5. 出局角色小卡不受影响 ---------------- */
const removedRule = /\.removed-corner\s+\.char-card\.mini\s*,\s*\.removed-corner\s+\.facedown\.sm\s*\{([^}]*)\}/.exec(baseCss);
ok(!!removedRule && /height\s*:\s*\d+px\s*!important/.test(removedRule[1]),
  '「本轮出局角色」小卡依旧是固定宽高（width/height 都写了 !important）');
ok(/\.removed-corner\s+\.char-card\.mini\s+\.cc-art\s*\{[^}]*height\s*:\s*100%/.test(baseCss),
  '小卡的 .cc-art 显式 height:100% → 同时有宽有高时 aspect-ratio 自动失效，尺寸不受新规则影响');

/* ---------------- 6. 角色一览同样对齐，且不碰建筑卡图 ---------------- */
const refRule = /html\[data-theme="neon"\]\s*\.ref-card\s+\.rc-art:not\(\.district-ref-art\)\s*\{([^}]*)\}/.exec(neonCss);
ok(!!refRule, '角色一览的角色卡图也套用同一比例');
ok(/aspect-ratio\s*:\s*var\(--role-card-ratio\)/.test(refRule[1]) && /object-fit\s*:\s*cover/.test(refRule[1]),
  '角色一览同样用 --role-card-ratio + cover');
ok(/:not\(\.district-ref-art\)/.test(refRule[0]),
  '排除建筑卡图（建筑 30 张缩略图本来就统一 280×420，不需要也不应该被改）');

/* ---------------- 7. 缓存版本已更新 ---------------- */
const themeVer = /themes\/neon\/theme\.css\?v=(\d+)/.exec(indexHtml);
ok(!!themeVer, 'index.html 里 theme.css 带版本号（当前 v=' + (themeVer ? themeVer[1] : '?') + '）');

console.log('\nrole-card-height: ' + pass + ' 项断言全部通过');
