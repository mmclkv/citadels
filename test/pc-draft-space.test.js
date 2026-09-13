/* PC 选角阶段应使用完整棋盘高度，并保持圆桌型玩家分布。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const start = css.indexOf('/* PC / 大屏（>=821px）');
const end = css.indexOf('/* PWA 独立窗口');
const pc = css.slice(start, end);

assert.ok(/id="play-area" class="play-area"/.test(html),
  '#play-area 带有 .play-area，能够在选角阶段参与 flex 高度分配');
assert.ok(/#screen-game\.draft-phase \.play-area\s*\{[^}]*flex\s*:\s*1 1 auto[^}]*min-height\s*:\s*0/.test(pc),
  '选角场上区域填满角色牌池下方的全部剩余高度');
assert.ok(/#screen-game\.draft-phase \.table-arena\s*\{[^}]*flex\s*:\s*1 1 auto[^}]*position\s*:\s*relative/.test(pc),
  '棋盘填满场上区域并作为玩家绝对定位的边界');
assert.ok(/#screen-game\.draft-phase \.opponents\[data-layout="ring"\]\s*\{[^}]*position\s*:\s*absolute[^}]*inset\s*:\s*0[^}]*height\s*:\s*100%/.test(pc),
  '对手座位环覆盖完整棋盘，而不是挤在顶部横排');
assert.ok(/#screen-game\.draft-phase \.opponents\[data-layout="ring"\] \.opp\s*\{[^}]*left\s*:\s*calc\(var\(--seat-x\)[^}]*top\s*:\s*calc\(var\(--seat-y\)/.test(pc),
  'PC 选角阶段继续使用圆桌座位坐标');
assert.ok(/#screen-game\.draft-phase \.me-area\s*\{[^}]*position\s*:\s*absolute[^}]*bottom\s*:\s*10px/.test(pc),
  '我的城市固定在棋盘下方的当前玩家座位');
assert.ok(/#screen-game\.draft-phase \.me-area\s*\{[^}]*height\s*:\s*clamp\(390px,46%,440px\)/.test(pc),
  '我的城市使用充足的棋盘高度，完整容纳角色、城区和手牌');
assert.ok(/href="\.\/style\.css\?v=52"/.test(html), '样式缓存版本已更新');

console.log('PC 选角阶段全屏圆桌布局：8 项断言全部通过');
