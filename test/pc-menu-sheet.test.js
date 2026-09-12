/* PC 端「顶栏收进右下角浮动菜单 + 删掉选角横条」的回归测试。
 *
 * 背景：PC 桌面宽度下，最上面一整条菜单栏（菜单/速度/第N轮/牌堆/皇冠 + 主题/角色一览/
 * 建筑一览/游戏规则/战报）加上棋盘上方的「选角阶段 + 行动指引」圆角横条，把棋盘挤得
 * 很扁。改为：
 *   1. 顶栏在 PC 端默认收起，点右下角浮动「☰ 菜单」按钮后在按钮上方弹出（复用移动端
 *      已有的 .mobile-menu-open 开关与弹出式 .topbar 样式）；
 *   2. 选角阶段的横条整块隐藏（选角者/牌池由牌池本身表达，场上局势在下方）；
 *   3. 行动阶段保留「轮到谁」横条，但不再单列一行「行动指引」。
 *
 * 本测试是纯静态断言（不依赖浏览器），锁住的不变量：
 *   A. 顶栏节点与全部子控件必须留在 DOM 里 —— app.js 直接按 id 取它们，
 *      删掉会整站报 null 错；隐藏只能靠 CSS。
 *   B. PC 规则必须写在移动端 / PWA 规则之前，否则会反把移动端顶掉。
 *   C. 轮末「确认本轮战果」块复用同一个横条容器，选角阶段隐藏规则必须带 :not(.rc)，
 *      否则会把确认按钮一起藏掉 —— 那是「点了没反应」级别的严重事故。
 *   D. 菜单项点击后自动收起，但「电脑节奏」要连点切换，不能收。
 *   E. 右下角浮动按钮要给行动栏留出位置，不能压住行动选项。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

let pass = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  pass++;
  console.log('  ✓ ' + label);
}

/* 取出 PC（>=821px）那一块 CSS：从标记注释到下一个 PWA 注释之间 */
const PC_START = '/* PC / 大屏（>=821px）';
const PC_END = '/* PWA 独立窗口';
const pcStart = css.indexOf(PC_START);
const pcEnd = css.indexOf(PC_END);
ok(pcStart >= 0, 'style.css 里有 PC 端菜单浮层规则块');
ok(pcEnd > pcStart, 'PC 块之后紧跟原有的 PWA 规则块（未破坏既有结构）');
const pc = css.slice(pcStart, pcEnd);
ok(/@media\s*\(min-width:821px\)/.test(pc), 'PC 规则限定在 @media (min-width:821px) 内，不波及移动端');

/* ---- 顺序：PC 块必须在移动端 / PWA 块之前，让后两者仍可覆盖 ---- */
const mobileStart = css.indexOf('@media (max-width:820px)');
const pwaStart = css.indexOf('@media (display-mode:standalone), (display-mode:fullscreen)');
ok(mobileStart >= 0 && pwaStart >= 0, '移动端与 PWA 规则块仍在');
ok(pcStart > mobileStart, 'PC 块写在移动端规则之后');
ok(pcStart < pwaStart, 'PC 块写在 PWA 规则之前，PWA 自身尺寸规则仍然生效');

/* ---- A. 顶栏节点与控件必须保留 ---- */
const topbarIds = ['btn-back-home', 'btn-speed', 'tb-room', 'tb-round', 'tb-target', 'tb-deck', 'tb-crown',
  'tb-effects', 'btn-theme', 'btn-chars', 'btn-buildings', 'btn-rules-top', 'btn-log-toggle'];
ok(/<header class="topbar" id="topbar">/.test(html), '顶栏 #topbar 仍在 DOM 中（只靠 CSS 收起，没有删除节点）');
topbarIds.forEach(id => ok(html.indexOf('id="' + id + '"') >= 0, '顶栏控件 #' + id + ' 仍在 DOM 中'));
ok(/id="mobile-menu-toggle"/.test(html), '右下角浮动菜单按钮 #mobile-menu-toggle 仍在 DOM 中');

/* ---- B. PC 端：默认收起 / 展开时右下角弹出 ---- */
ok(/#screen-game:not\(\.mobile-menu-open\)\s+\.topbar\s*\{\s*display\s*:\s*none/.test(pc),
  'PC 端菜单收起时顶栏 display:none');
ok(/#screen-game\.mobile-menu-open\s+\.topbar\s*\{[^}]*position\s*:\s*fixed/.test(pc),
  'PC 端菜单展开时顶栏改成 fixed 浮层');
ok(/#screen-game\.mobile-menu-open\s+\.topbar\s*\{[^}]*right\s*:\s*\d+px/.test(pc) &&
  /#screen-game\.mobile-menu-open\s+\.topbar\s*\{[^}]*bottom\s*:\s*\d+px/.test(pc),
  '浮层锚定在右下角（right + bottom）');
ok(/\.mobile-menu-toggle\s*\{[^}]*position\s*:\s*fixed/.test(pc), 'PC 端浮动菜单按钮是 fixed 定位');
ok(/\.mobile-menu-toggle\s*\{[^}]*display\s*:\s*inline-flex/.test(pc), 'PC 端浮动菜单按钮可见（覆盖基础样式里的 display:none）');
ok(/\.mobile-menu-toggle\s*\{[^}]*right\s*:\s*\d+px[^}]*bottom\s*:\s*\d+px|\.mobile-menu-toggle\s*\{[^}]*bottom\s*:\s*\d+px[^}]*right\s*:\s*\d+px/.test(pc),
  '浮动菜单按钮贴在画面右下角');
ok(/\.tb-left[\s\S]*?\.tb-mid[\s\S]*?\.tb-right/.test(pc), '浮层里三组控件各占一行（tb-left/tb-mid/tb-right）');

/* ---- C. 选角横条：隐藏，但必须放过轮末确认块 ---- */
ok(/#screen-game\.draft-phase\s+\.turn-banner:not\(\.rc\)\s*\{[^}]*display\s*:\s*none\s*!important/.test(pc),
  '选角阶段隐藏「选角阶段 + 行动指引」横条');
ok(!/#screen-game\.draft-phase\s+\.turn-banner\s*\{[^}]*display\s*:\s*none/.test(pc),
  '没有不带 :not(.rc) 的同名规则（否则会连「确认本轮战果」按钮一起藏掉）');
ok(/\.turn-banner:not\(\.rc\)/.test(pc) && /renderRoundConfirm[\s\S]*?classList\.add\('rc'\)/.test(appJs),
  '轮末确认块确实会带 .rc 类（:not(.rc) 保护有效）');
ok(/#screen-game\s+\.turn-order-guide\s*\{\s*display\s*:\s*none\s*!important/.test(pc),
  'PC 端不再单列「行动指引」一行（用 !important 顶掉内联 display:flex）');

/* ---- D. 交互：共用一个开关，Esc 先收菜单，点菜单项自动收起 ---- */
ok(/function setMenuOpen\(open\)/.test(appJs), 'app.js 抽出共用的 setMenuOpen(open)');
ok(/mobileMenuToggle\.onclick\s*=\s*\(\)\s*=>\s*setMenuOpen\(!gameScreen\.classList\.contains\('mobile-menu-open'\)\)/.test(appJs),
  '浮动按钮点击 = 反转菜单开关');
ok(/e\.key\s*!==\s*'Escape'[\s\S]{0,200}setMenuOpen\(false\)[\s\S]{0,120}closeModal\(\)/.test(appJs),
  'Esc 先收起菜单再关弹层');
ok(/topbarEl\.addEventListener\('click'/.test(appJs) && /btn\.id\s*===\s*'btn-speed'/.test(appJs),
  '点菜单项后自动收起，但「电脑节奏」按钮保持展开（可连点切换）');

/* ---- E. 浮动按钮不压住行动选项 ---- */
ok(/#screen-game\s+\.actionbar\s*\{\s*padding-right\s*:\s*\d+px/.test(pc),
  '行动栏右侧留出浮动按钮的位置（padding-right）');
const m = pc.match(/#screen-game\s+\.actionbar\s*\{\s*padding-right\s*:\s*(\d+)px/);
ok(m && Number(m[1]) >= 90, '预留宽度足够放下「☰ 菜单」按钮（当前 ' + (m && m[1]) + 'px）');

/* ---- 文案不再和浮动按钮撞名 ---- */
ok(!/id="btn-back-home">菜单</.test(html), '顶栏里的「菜单」已改名为「返回主菜单」，不与浮动按钮重名');

/* ---- 移动端 / PWA 既有行为没被动过 ---- */
ok(/#screen-game\s+\.turn-banner,\s*\n\s*#screen-game\s+\.turn-order-guide\s*\{\s*display\s*:\s*none\s*!important\s*\}/.test(css),
  '移动端依旧整块隐藏横条与行动指引');
ok(/\.mobile-menu-toggle\s*\{\s*position\s*:\s*fixed/.test(css.slice(mobileStart, pwaStart)),
  '移动端浮动菜单按钮样式保持不变');

/* ---- 缓存版本号已推进（改的是样式与脚本，必须让浏览器拿新的） ---- */
ok(/href="\.\/style\.css\?v=(\d+)"/.test(html), 'index.html 给 style.css 带了版本号');
ok(/src="\.\/app\.js\?v=(\d+)"/.test(html), 'index.html 给 app.js 带了版本号');
ok(/themes\/neon\/theme\.css\?v=/.test(html), '主题样式版本号仍在');

console.log('\nPC 菜单浮层 + 选角横条收起：' + pass + ' 项断言全部通过');
