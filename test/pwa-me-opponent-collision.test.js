/* PWA 5+：我的玩家面板不能覆盖环形布局中的其他玩家。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert.ok(/function resolvePwaMeOpponentCollisions\(\)/.test(app),
  '存在我的面板与对手面板的最终碰撞检测');
assert.ok(/root\.style\.setProperty\('--mobile-fit-scale', '1'\);[\s\S]{0,260}resolvePwaMeOpponentCollisions\(\)/.test(app),
  '碰撞检测在清除旧缩放之后、测量新缩放之前执行');
assert.ok(/overlapX > 0 && overlapY > 0/.test(app) &&
  /--pwa-me-clearance/.test(app),
  '使用实际 DOM 矩形的横纵交集计算必要间距');
assert.ok(/wrap\.dataset\.ringBaseHeight/.test(app),
  '每次布局保存环形区基础高度，避免重复测量累加空白');
assert.ok(/arena\.dataset\.layout\s*=\s*wrap\.dataset\.layout/.test(app),
  '父棋盘同步记录移动环形布局，供 PWA 解除桌面裁剪规则');

const flowRule = /\.me-area\.pwa-collision-flow\s*\{([^}]*)\}/.exec(css);
assert.ok(flowRule, 'PWA 碰撞布局拥有独立样式');
assert.ok(/position\s*:\s*relative!important/.test(flowRule[1]) &&
  /bottom\s*:\s*auto!important/.test(flowRule[1]) &&
  /transform\s*:\s*none!important/.test(flowRule[1]),
  'PWA 下覆盖 PC 选角阶段的绝对定位，让我的面板回到正常流');
assert.ok(/#screen-game #opponents\[data-layout="mobile-ring"\] ~ \.me-area\.pwa-collision-flow\.pwa-collision-compact/.test(css),
  '空间不足时提供保持 2:3 卡牌比例的紧凑布局');
const draftArenaRule = /#screen-game\.draft-phase \.table-arena\[data-layout="mobile-ring"\]\s*\{([^}]*)\}/.exec(css);
assert.ok(draftArenaRule && /height\s*:\s*auto!important/.test(draftArenaRule[1]) &&
  /min-height\s*:\s*0!important/.test(draftArenaRule[1]) &&
  /overflow\s*:\s*visible!important/.test(draftArenaRule[1]),
  'PWA 环形选角棋盘按内容展开且不裁掉我的城市');
assert.ok(/style\.css\?v=53/.test(html) && /app\.js\?v=71/.test(html),
  '静态资源版本已更新，PWA 能获取新布局代码');

console.log('PWA 我的面板与对手碰撞回归：9 项断言全部通过');
