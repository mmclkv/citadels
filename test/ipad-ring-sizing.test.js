// iPad PWA 环形玩家框尺寸自适应回归测试
//
// 背景：手机档的环形玩家框在 iPad 上显得过小（style.css 里 pwa-many-players
// 把建筑牌固定成 32x48），四周留大片空白。修复思路是在 app.js 的
// applyMobileRingLayout 中引入 spacious（宽 >=900 且高 >=560）分支放大尺寸，
// 并在 style.css 用同条件的媒体查询放大圆角矩形内部元素。
//
// 本测试用纯计算复刻这段逻辑，锁住三条不变量：
//   1. 大屏（iPad）确实放大，手机档数值保持原样（不能误伤手机）
//   2. 两种判据（JS 与 CSS 媒体查询）条件一致，避免样式与计算不同步
//   3. 放大后环形上下两排玩家框仍有足够垂直间距，不会被碰撞逻辑压回手机尺寸
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// —— 复刻 app.js applyMobileRingLayout 的尺寸计算 ——
function computeSizing({ wrapWidth, viewportH, totalPlayers, pwa }) {
  const width = Math.max(280, wrapWidth);
  const spacious = width >= 900 && viewportH >= 560;
  const boost = spacious ? 1.25 : 1;
  const maxWidth = Math.max(126, Math.floor(width * (pwa && totalPlayers >= 5
    ? (totalPlayers >= 7 ? .34 : .38)
    : (totalPlayers >= 7 ? .46 : totalPlayers >= 5 ? .5 : .58)) * boost));
  const baseRatio = pwa && totalPlayers >= 5 ? (spacious ? .24 : .18) : .25;
  const cardWidth = Math.max(104, Math.min(maxWidth, Math.floor(width * baseRatio * boost)));
  const height = pwa && totalPlayers >= 5
    ? Math.max(420, Math.min(spacious ? 600 : 620, Math.round(viewportH * (spacious ? .72 : .62))))
    : Math.max(300, Math.min(400, Math.round(viewportH * .44)));
  return { spacious, boost, maxWidth, cardWidth, height, cityCardBase: spacious ? 44 : 40 };
}

// 玩家框最终宽度 ≈ min(maxWidth, max(cardWidth, 按建筑数算出的需求宽度))
function panelWidth(sz, cityCount) {
  const cityNeed = cityCount ? 18 + Math.min(cityCount, 7) * (sz.cityCardBase + 3) : 0;
  return Math.min(sz.maxWidth, Math.max(sz.cardWidth, cityNeed));
}

// —— 环形座位几何：复刻 renderOpponents 的既约半径 ——
const RADIUS_X = { many: 40, few: 36 };
const RADIUS_Y = { many: 40, few: 38 };
function seatCenters(wrapWidth, wrapHeight, opponents) {
  // opponents = 除自己外的对手数；总人数 = opponents + 1
  const total = opponents + 1;
  const rx = total >= 5 ? RADIUS_X.many : RADIUS_X.few;
  const ry = total >= 5 ? RADIUS_Y.many : RADIUS_Y.few;
  const out = [];
  for (let rel = 1; rel <= opponents; rel++) {
    const angle = Math.PI / 2 + (rel / total) * Math.PI * 2;
    out.push({
      x: (50 + Math.cos(angle) * rx) / 100 * wrapWidth,
      y: (50 + Math.sin(angle) * ry) / 100 * wrapHeight,
    });
  }
  return out;
}
// 顶部溢出时会被 clamp 向下推入容器内，取"推入后"的位置做保守估算
function pushInsideRing(center, panelW, panelH, wrapWidth, gap) {
  let x = center.x, y = center.y;
  const left = x - panelW / 2, right = x + panelW / 2;
  const top = y - panelH / 2, bottom = y + panelH / 2;
  if (left < gap) x += gap - left;
  if (right > wrapWidth - gap) x -= right - (wrapWidth - gap);
  if (top < gap) y += gap - top;
  return { x, y, top: y - panelH / 2, bottom: y + panelH / 2 };
}

// 放大后的玩家框高度估算（上 padding 10 + 角色状态牌 72 + gap 7 + 头部 32 + gap 6
// + 建筑牌 66 + 下 padding 10），手机档用较矮的旧值 150 作对照
const PANEL_H_SPACIOUS = 203;
const PANEL_H_PHONE = 150;

let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; console.log('  ✓ ' + msg); }

console.log('iPad 环形玩家框尺寸自适应');

// —— 1. 大屏放大、手机档不变 ——
const ipad = computeSizing({ wrapWidth: 1120, viewportH: 820, totalPlayers: 5, pwa: true });   // iPad 10.9" 横屏
const ipad97 = computeSizing({ wrapWidth: 980, viewportH: 768, totalPlayers: 5, pwa: true });  // iPad 9.7" 横屏
const phone = computeSizing({ wrapWidth: 800, viewportH: 390, totalPlayers: 5, pwa: true });   // 手机横屏
const phonePortrait = computeSizing({ wrapWidth: 390, viewportH: 844, totalPlayers: 5, pwa: true });

ok(ipad.spacious && ipad97.spacious, 'iPad 横屏命中 spacious 分支');
ok(!phone.spacious, '手机横屏（高 390）不命中 spacious，尺寸不受影响');
ok(!phonePortrait.spacious, '手机竖屏（宽 390）不命中 spacious，尺寸不受影响');

const ipadPanel = panelWidth(ipad, 6);
const phonePanel = panelWidth(phone, 6);
ok(ipadPanel > phonePanel * 1.15,
  'iPad 玩家框明显更宽（' + phonePanel + 'px → ' + ipadPanel + 'px，+'
  + Math.round((ipadPanel / phonePanel - 1) * 100) + '%）');
ok(ipad.cityCardBase === 44 && phone.cityCardBase === 40,
  '建筑牌基准宽度大屏 44 / 手机 40（CSS 原先把手机档锁死在 32px）');
ok(ipad.height === Math.round(820 * .72) && ipad97.height === Math.round(768 * .72),
  '环形区高度按视口 72% 提升（iPad 820→' + ipad.height + 'px，768→' + ipad97.height + 'px）');
ok(phone.height === 420 && phonePortrait.height === Math.round(844 * .62),
  '手机档沿用原 .62 系数（横屏取下限 420px，竖屏 523px），未被改动');

// —— 2. JS 判据与 CSS 媒体查询条件一致 ——
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
ok(css.indexOf('(min-width:900px) and (min-height:560px)') >= 0,
  'style.css 存在 min-width:900px + min-height:560px 的大屏媒体查询');
const cssBlock = css.slice(css.indexOf('(min-width:900px) and (min-height:560px)'));
ok(/\.opponents\[data-layout="mobile-ring"\] \.opp \.cs-card\{[\s\S]{0,160}width:48px!important/.test(cssBlock),
  'CSS 大屏下角色牌放大到 48×72');
ok(/\.opp-city>\.card\{[\s\S]{0,200}width:var\(--mobile-city-card-width,44px\)!important/.test(cssBlock),
  'CSS 大屏下建筑牌改用引擎算出的自适应变量，解除 32px 锁死');
ok(cssBlock.indexOf('aspect-ratio:2 / 3') >= 0, '建筑牌保持 2:3 比例，卡图不被拉伸');

// —— 3. 放大后环形上下两排不会互相挤压 ——
// 5 人局 = 4 个对手：相对座位 1..4，其中 2/3 在上排、1/4 在下排
[['iPad 10.9"', ipad, 1120], ['iPad 9.7"', ipad97, 980]].forEach(([name, sz, wrapW]) => {
  const centers = seatCenters(wrapW, sz.height, 4);
  const gap = Math.max(6, Math.round(Math.min(14, wrapW * .018)));
  const boxes = centers.map(c => pushInsideRing(c, panelWidth(sz, 6), PANEL_H_SPACIOUS, wrapW, gap));
  // 用面板中心判断属于上排还是下排（顶边会被 clamp 推入，不能作为分组依据）
  const mid = b => (b.top + b.bottom) / 2;
  const upper = boxes.filter(b => mid(b) < sz.height / 2);
  const lower = boxes.filter(b => mid(b) >= sz.height / 2);
  ok(upper.length === 2 && lower.length === 2, name + '：4 个对手分成上下两排（上 '
    + upper.length + ' / 下 ' + lower.length + '）');
  const upperBottom = Math.max.apply(null, upper.map(b => b.bottom));
  const lowerTop = Math.min.apply(null, lower.map(b => b.top));
  ok(lowerTop - upperBottom >= gap - 1,
    name + '：上下两排玩家框留有间距（' + Math.round(lowerTop - upperBottom)
    + 'px，面板高 ' + PANEL_H_SPACIOUS + 'px）');
  ok(Math.max.apply(null, boxes.map(b => b.bottom)) <= sz.height,
    name + '：玩家框不超出环形区底部（' + sz.height + 'px）');
});

// 手机档仍按原尺寸排布（回归对照）
const phoneCenters = seatCenters(800, phone.height, 4);
const phoneGap = Math.max(6, Math.round(Math.min(14, 800 * .018)));
const phoneBoxes = phoneCenters.map(c => pushInsideRing(c, phonePanel, PANEL_H_PHONE, 800, phoneGap));
const pMid = b => (b.top + b.bottom) / 2;
const pUpperBottom = Math.max.apply(null, phoneBoxes.filter(b => pMid(b) < phone.height / 2).map(b => b.bottom));
const pLowerTop = Math.min.apply(null, phoneBoxes.filter(b => pMid(b) >= phone.height / 2).map(b => b.top));
ok(pLowerTop - pUpperBottom >= phoneGap - 1,
  '手机档上下两排间距不变（' + Math.round(pLowerTop - pUpperBottom) + 'px），未被放大逻辑影响');

console.log('\n全部 ' + passed + ' 项断言通过');
