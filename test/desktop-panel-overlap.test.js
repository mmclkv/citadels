/* PC 桌面圆桌布局的玩家框重叠回归测试。
 *
 * 背景：5 人局时 4 名对手占据相对座位 1~4，座位 1/2 同在圆桌左侧、3/4 同在右侧，
 * 两张框的横向中心距只有座位半径差的 0.363 倍（半径 40 → 14.5% 圆桌宽），而玩家框
 * 宽度是 min(340px, 21%)，比间距还宽 → 圆角矩形必然互相压住。2560 宽的屏幕上压
 * 约 14px（用户截图实测 14×155px），1920 宽的屏幕上要压 100px 以上。
 *
 * 修复：renderOpponents 的桌面分支在跑完 resolveOpponentTableCollisions 之后，
 * 追加 separateOpponentPanels(wrap) 做两两互斥分离（先推、推不动再收缩宽度）。
 *
 * 本测试不复制算法，而是把 app.js 里的真实函数源码抽出来，配上矩形模型直接跑，
 * 保证测的就是线上代码。锁住的不变量：
 *   1. 修复前的几何确实会重叠（防止把场景写错）
 *   2. 跑完分离后任意两张玩家框都不再相交，且都不越出圆桌区
 *   3. 宽屏下只推不缩（玩家框尺寸不被压小），窄屏才允许收缩兜底
 *   4. 4 人局的顶部座位不会被推到中央圆桌上
 *   5. app.js 的桌面分支确实调用了它，style.css 关掉了分离期间的宽度过渡
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

// ---- 从 app.js 抽真实函数源码 ----
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('app.js 中找不到 ' + name);
  let depth = 0;
  for (let p = src.indexOf('{', start); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
  }
  throw new Error(name + ' 花括号不配对');
}
function loadFn(name, dollar) {
  return new Function('$', extractFn(appSrc, name) + '\nreturn ' + name + ';')(dollar);
}

// ---- 最小 DOM / 矩形模型（与 .opp 的定位方式一致）----
// .opp 用 left:seat-x% + translate(-50%,-50%)，所以中心恒等于座位点，宽度变化不会挪中心。
class FakeStyle {
  constructor() { this.props = {}; }
  setProperty(k, v) { this.props[k] = v; }
}
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}
class FakeNode {
  constructor(cx, cy, w, h) {
    this.cx = cx; this.cy = cy; this.baseW = w; this.h = h;
    this.dataset = { pushX: '0', pushY: '0' };
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
  }
  pushX() { return parseFloat(this.dataset.pushX || '0') || 0; }
  pushY() { return parseFloat(this.dataset.pushY || '0') || 0; }
  get width() { const w = parseFloat(this.style.props.width); return isFinite(w) && w > 0 ? w : this.baseW; }
  getBoundingClientRect() {
    const w = this.width;
    const left = this.cx + this.pushX() - w / 2;
    const top = this.cy + this.pushY() - this.h / 2;
    return { left, top, right: left + w, bottom: top + this.h, width: w, height: this.h };
  }
}
class FakeWrap extends FakeNode {
  constructor(w, h) { super(w / 2, h / 2, w, h); this.nodes = []; }
  querySelectorAll() { return this.nodes.slice(); }
  getBoundingClientRect() { return { left: 0, top: 0, right: this.baseW, bottom: this.h, width: this.baseW, height: this.h }; }
}

// ---- 复刻 renderOpponents 的桌面圆桌座位几何 ----
const WRAP_H = 600;         // .opponents{height:600px}
const TOP_SEAT_SHIFT = 110; // 5 人局正上方两个座位为避免压住行动指引条而下移
function seatCenters(totalPlayers, wrapW, panelHeights) {
  const rx = totalPlayers >= 7 ? 43 : totalPlayers >= 5 ? 40 : 36;
  const ry = totalPlayers >= 7 ? 42 : totalPlayers >= 5 ? 40 : 38;
  const cardWidth = totalPlayers >= 8 ? 17 : totalPlayers >= 7 ? 19 : totalPlayers >= 5 ? 21 : 30;
  const out = [];
  for (let rel = 1; rel < totalPlayers; rel++) {
    const angle = Math.PI / 2 + rel / totalPlayers * Math.PI * 2;
    const isTopSeat = totalPlayers === 4 ? rel === 2 : totalPlayers === 5 && (rel === 2 || rel === 3);
    const shift = !isTopSeat ? 0 : (totalPlayers === 5 ? TOP_SEAT_SHIFT : 58);
    const w = totalPlayers === 4
      ? Math.min(700, 340 + Math.max(0, 5 - 5) * 90)
      : Math.min(340, wrapW * cardWidth / 100);
    out.push(new FakeNode(
      (50 + Math.cos(angle) * rx) / 100 * wrapW,
      (50 + Math.sin(angle) * ry) / 100 * WRAP_H + (totalPlayers === 4 ? 42 : 0) + shift,
      w, panelHeights[rel] || 260
    ));
  }
  return out;
}
// 中央圆桌：#table-core 相对圆桌区（#opponents 上沿 +35px 的指引条）的矩形
function tableRect(wrapW) {
  const w = Math.min(wrapW * .3, 360);
  return { left: wrapW / 2 - w / 2, right: wrapW / 2 + w / 2, top: 210, bottom: 400, width: w, height: 190 };
}

function overlaps(a, b) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > 0 && oy > 0 ? { ox, oy } : null;
}
function pairOverlaps(nodes) {
  const bad = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const hit = overlaps(nodes[i].getBoundingClientRect(), nodes[j].getBoundingClientRect());
      if (hit) bad.push({ i, j, ox: Math.round(hit.ox), oy: Math.round(hit.oy) });
    }
  }
  return bad;
}

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.error('  ✗ ' + msg); }
}

console.log('PC 桌面 5 人局玩家框重叠');

// 面板高度取用户截图的实测值（座位 2 有 5 张建筑 → 363px，座位 4 有 3 张 → 263px）
const HEIGHTS_5P = { 1: 263, 2: 363, 3: 363, 4: 263 };

// —— 1. 修复前的几何确实重叠（场景自检）——
[2245, 1920, 1600, 1400].forEach(wrapW => {
  const seats = seatCenters(5, wrapW, HEIGHTS_5P);
  const bad = pairOverlaps(seats);
  ok(bad.length === 2, wrapW + 'px 宽：座位 1×2、3×4 各重叠一次（未修复时的原始几何）');
});
// 屏幕足够宽时 min(340px,21%) 收敛到 340px，横向间距超过框宽，本来就不会重叠
ok(pairOverlaps(seatCenters(5, 2560, HEIGHTS_5P)).length === 0,
  '2560px 宽：间距已大于 340px 上限，原始几何本来就不重叠（分离函数应保持不动）');
const wide = seatCenters(5, 2245, HEIGHTS_5P);
const rawHit = overlaps(wide[0].getBoundingClientRect(), wide[1].getBoundingClientRect());
ok(rawHit && Math.round(rawHit.ox) === 14 && Math.round(rawHit.oy) === 155,
  '与用户截图一致：重叠 14 × 155px（面板宽 min(340px,21%)=340px）');

// —— 2. 跑真实函数后不再重叠、且不越出圆桌区 ——
const separate = loadFn('separateOpponentPanels', () => null);

[2560, 2245, 1920, 1600, 1400, 1200].forEach(wrapW => {
  const wrap = new FakeWrap(wrapW, WRAP_H);
  wrap.nodes = seatCenters(5, wrapW, HEIGHTS_5P);
  separate(wrap);
  const bad = pairOverlaps(wrap.nodes);
  ok(bad.length === 0, wrapW + 'px 宽：分离后任意两张玩家框都不相交'
    + (bad.length ? '（残留 ' + JSON.stringify(bad) + '）' : ''));
  const outside = wrap.nodes.filter(n => {
    const r = n.getBoundingClientRect();
    return r.left < -0.5 || r.right > wrapW + 0.5 || r.top < -0.5 || r.bottom > WRAP_H + 0.5;
  });
  ok(outside.length === 0, wrapW + 'px 宽：玩家框都留在圆桌区内');
});

// —— 3. 宽屏只推不缩，窄屏才允许收缩兜底 ——
[2245, 1920, 1600].forEach(wrapW => {
  const wrap = new FakeWrap(wrapW, WRAP_H);
  wrap.nodes = seatCenters(5, wrapW, HEIGHTS_5P);
  const before = wrap.nodes.map(n => n.getBoundingClientRect().width);
  separate(wrap);
  const after = wrap.nodes.map(n => n.getBoundingClientRect().width);
  ok(before.every((w, i) => Math.abs(w - after[i]) < .5),
    wrapW + 'px 宽：只推开、不缩小玩家框（' + Math.round(before[0]) + 'px 保持不变）');
  const pushed = wrap.nodes.some(n => Math.abs(n.pushX()) > .5);
  ok(pushed, wrapW + 'px 宽：确实通过位移完成分离（' + wrap.nodes.map(n => Math.round(n.pushX())).join(', ') + '）');
});
// 本来就不重叠的宽屏不应被无谓挪动
const noop = new FakeWrap(2560, WRAP_H);
noop.nodes = seatCenters(5, 2560, HEIGHTS_5P);
separate(noop);
ok(noop.nodes.every(n => !n.pushX() && !n.pushY()), '2560px 宽：原本不重叠时不做任何位移');

// 分离是对称的：两侧各有余量时一起让位，不会把一侧整体推歪
const sym = new FakeWrap(2245, WRAP_H);
sym.nodes = seatCenters(5, 2245, HEIGHTS_5P);
separate(sym);
// 座位 1/3 在左、座位 2/4 在右 → 镜像关系是 1↔4、2↔3
ok(Math.abs(sym.nodes[0].pushX() + sym.nodes[3].pushX()) < .5 &&
   Math.abs(sym.nodes[1].pushX() + sym.nodes[2].pushX()) < .5,
  '左右两侧对称分离（座位1/4 与 座位2/3 的位移互为镜像）');
ok(sym.nodes[0].pushX() < 0 && sym.nodes[1].pushX() > 0,
  '座位 1 向左、座位 2 向右，两张框背向分开');

// —— 4. 4 人局：顶部座位不被推到中央圆桌上 ——
[[2560, 2245], [1920, 1600], [1400, 1200]].forEach(([arenaW, wrapW]) => {
  const wrap = new FakeWrap(wrapW, WRAP_H);
  wrap.nodes = seatCenters(4, wrapW, { 1: 250, 2: 250, 3: 250 });
  const tr = tableRect(arenaW);
  const before = wrap.nodes.some(n => overlaps(n.getBoundingClientRect(), tr));
  separate(wrap);
  const after = wrap.nodes.some(n => overlaps(n.getBoundingClientRect(), tr));
  ok(before === after, wrapW + 'px 宽 4 人局：分离没有把玩家框推到中央圆桌上');
  ok(pairOverlaps(wrap.nodes).length === 0, wrapW + 'px 宽 4 人局：玩家框之间也不相交');
});

// —— 5. 6~8 人局不炸：不抛异常、玩家框留在圆桌区内 ——
[6, 7, 8].forEach(total => {
  const wrapW = 2245;
  const wrap = new FakeWrap(wrapW, WRAP_H);
  const heights = {};
  for (let rel = 1; rel < total; rel++) heights[rel] = 240;
  wrap.nodes = seatCenters(total, wrapW, heights);
  let err = null;
  try { separate(wrap); } catch (e) { err = e; }
  ok(!err, total + ' 人局：分离函数不抛异常' + (err ? '（' + err.message + '）' : ''));
  const outside = wrap.nodes.filter(n => {
    const r = n.getBoundingClientRect();
    return r.left < -0.5 || r.right > wrapW + 0.5 || r.bottom > WRAP_H + 0.5;
  });
  ok(outside.length === 0, total + ' 人局：玩家框留在圆桌区内');
});

// —— 6. 接线：app.js 桌面分支确实调用、CSS 关掉过渡 ——
ok(/resolveOpponentTableCollisions\(\);\s*\n\s*\/\/[^\n]*\n\s*separateOpponentPanels\(wrap\);/.test(appSrc),
  'renderOpponents 的桌面分支在圆桌碰撞之后调用了 separateOpponentPanels(wrap)');
ok(/if \(mobileRingLayout\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,200}?separateOpponentPanels/.test(appSrc),
  '调用点在 else（桌面）分支内，移动端环形布局不受影响');
ok(/\.opponents\.separating \.opp\{transition:none!important\}/.test(css),
  'style.css 在分离期间关闭 .opp 的宽度过渡（否则测量到过渡中间值会来回抖）');
ok(/wrap\.classList\.add\('separating'\)/.test(appSrc) && /wrap\.classList\.remove\('separating'\)/.test(appSrc),
  'separating 类在函数出入口成对增删');

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
