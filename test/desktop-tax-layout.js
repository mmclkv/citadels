/* Real-browser regression for the fixed central tax bag.
 * Run: node test/desktop-tax-layout.js (or set PLAYWRIGHT_PATH).
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const layoutCode = source.slice(source.indexOf('  function reserveDesktopTaxPotSpace('),
  source.indexOf('  const MOBILE_V12_DISTRICT_COLORS'));
const separationCode = source.slice(source.indexOf('  function separateOpponentPanels('),
  source.indexOf('  /* 得分明细浮动窗口 */'));
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8') +
  fs.readFileSync(path.join(root, 'public/themes/neon/theme.css'), 'utf8');

async function verify(page, label) {
  // Wait for ResizeObserver + its queued layout frame rather than assuming a
  // fixed delay is enough on busy machines.
  await page.waitForFunction(() => {
    const wrap = document.querySelector('#opponents').getBoundingClientRect();
    const pot = document.querySelector('#tax-pot');
    const cx = wrap.left + wrap.width / 2, cy = wrap.top + wrap.height / 2;
    const x = Math.max(pot.offsetWidth, pot.scrollWidth) * 1.16 / 2 + 11;
    const y = Math.max(pot.offsetHeight, pot.scrollHeight) * 1.16 / 2 + 11;
    const panels = Array.from(document.querySelectorAll('.opp'), node => node.getBoundingClientRect());
    return panels.every((r, i) => {
      return r.top >= wrap.top - 1 && r.bottom <= wrap.bottom + 1 &&
        !(r.left < cx + x && r.right > cx - x && r.top < cy + y && r.bottom > cy - y) &&
        panels.slice(i + 1).every(q => Math.min(r.right, q.right) <= Math.max(r.left, q.left) + 1 ||
          Math.min(r.bottom, q.bottom) <= Math.max(r.top, q.top) + 1);
    });
  }, null, { timeout: 5000 });
  const result = await page.evaluate(() => {
    const wrap = document.querySelector('#opponents').getBoundingClientRect();
    const pot = document.querySelector('#tax-pot');
    const r = pot.getBoundingClientRect();
    const cx = wrap.left + wrap.width / 2, cy = wrap.top + wrap.height / 2;
    const x = Math.max(pot.offsetWidth, pot.scrollWidth) * 1.16 / 2 + 11;
    const y = Math.max(pot.offsetHeight, pot.scrollHeight) * 1.16 / 2 + 11;
    const panels = Array.from(document.querySelectorAll('.opp'), n => n.getBoundingClientRect());
    const wrapNode = document.querySelector('#opponents');
    const rx = Number(wrapNode.style.getPropertyValue('--desktop-ring-radius-x'));
    const ry = Number(wrapNode.style.getPropertyValue('--desktop-ring-radius-y'));
    const count = Number(wrapNode.dataset.players);
    const errors = [];
    if (!(rx > 0 && ry > 0)) errors.push('Missing ring radii');
    panels.forEach((p, i) => {
      const seat = Number(document.querySelectorAll('.opp')[i].dataset.relativeSeat);
      const angle = Math.PI / 2 + seat / count * Math.PI * 2;
      if (Math.abs((p.left + p.width / 2 - cx) / rx - Math.cos(angle)) > .01 ||
          Math.abs((p.top + p.height / 2 - cy) / ry - Math.sin(angle)) > .01)
        errors.push('Panel ' + i + ' leaves its angular seat on the ring');
      if (p.left < cx + x && p.right > cx - x && p.top < cy + y && p.bottom > cy - y)
        errors.push('Panel ' + i + ' overlaps the tax bag animation safety zone');
      if (p.top < wrap.top - 1 || p.bottom > wrap.bottom + 1)
        errors.push('Panel ' + i + ' leaves the arena vertically');
      if (p.left < wrap.left - 1 || p.right > wrap.right + 1)
        errors.push('Panel ' + i + ' leaves the arena horizontally');
      panels.slice(i + 1).forEach(q => {
        if (Math.min(p.right, q.right) > Math.max(p.left, q.left) + 1 &&
            Math.min(p.bottom, q.bottom) > Math.max(p.top, q.top) + 1)
          errors.push('Player panels overlap');
      });
    });
    return { errors, dx: Math.abs(r.left + r.width / 2 - cx), dy: Math.abs(r.top + r.height / 2 - cy),
      wrap: { top: wrap.top, height: wrap.height },
      panels: panels.map(p => ({ left: p.left, right: p.right, top: p.top, bottom: p.bottom })),
      safe: document.querySelector('#opponents').className };
  });
  assert.deepEqual(result.errors, [], label + ': ' + JSON.stringify(result));
  assert.ok(result.dx < 1 && result.dy < 1, label + ': bag stays at the arena center');
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let cases = 0;
    for (const width of [1024, 1280, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      for (const phase of ['action', 'draft']) {
        for (let players = 2; players <= 8; players++) {
          await page.evaluate(() => { if (window.cleanTaxObserver) window.cleanTaxObserver(); });
          await page.setContent('<html data-theme="neon"><head><style>' + css +
            '</style></head><body><div id="screen-game" class="active ' +
            (phase === 'draft' ? 'draft-phase' : '') + '"><div id="table-arena" class="table-arena" ' +
            'style="width:calc(100vw - 60px);height:600px">' +
            '<div id="opponents" class="opponents" data-layout="ring">' +
            '<div id="tax-pot" class="tax-pot"><span class="tax-pot-mark">💰' +
            '<span class="tax-pot-count">999</span></span><span class="tax-pot-label">税务官</span></div>' +
            '</div></div></div></body></html>');
          await page.evaluate(({ players, layoutCode, separationCode }) => {
            window.$ = selector => document.querySelector(selector);
            window.isMobileOpponentLayout = () => false;
            window.eval(layoutCode + separationCode +
              '\nwindow.cleanTaxObserver = () => { if (desktopTaxLayoutObserver) desktopTaxLayoutObserver.disconnect();' +
              'if (desktopTaxLayoutFrame != null) cancelAnimationFrame(desktopTaxLayoutFrame); };');
            const wrap = $('#opponents');
            wrap.dataset.players = String(players);
            for (let seat = 1; seat < players; seat++) {
              const node = document.createElement('div');
              node.className = 'opp'; node.dataset.seat = seat;
              node.dataset.relativeSeat = String(seat);
              const angle = Math.PI / 2 + seat / players * Math.PI * 2;
              node.style.setProperty('--seat-x', String(50 + Math.cos(angle) * 36));
              node.style.setProperty('--seat-y', String(50 + Math.sin(angle) * 38));
              node.style.width = players === 4 ? '340px' : 'min(340px,24%)';
              // Includes the reported tall top seat and late-game cities.
              node.innerHTML = '<div style="height:' + (seat % 2 ? 264 : 420) + 'px">Player ' + seat + '</div>';
              wrap.appendChild(node);
            }
            separateOpponentPanels(wrap);
            reserveDesktopTaxPotSpace(wrap);
            observeDesktopTaxLayout(wrap);
          }, { players, layoutCode, separationCode });
          await verify(page, `${width}px ${phase} ${players} players`);
          if (process.env.DESKTOP_TAX_SCREENSHOT && width === 1920 && phase === 'action' && players === 4)
            await page.screenshot({ path: process.env.DESKTOP_TAX_SCREENSHOT, fullPage: true });
          // A loaded image or another building changes the panel's actual height.
          await page.locator('.opp > div').first().evaluate(n => n.style.height = '540px');
          await verify(page, `${width}px ${phase} ${players} players after content growth`);
          cases++;
        }
      }
    }
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.waitForTimeout(150);
    await verify(page, 'Resize after 8-player draft');
    const meFits = await page.evaluate(() => {
      const arena = document.querySelector('#table-arena');
      arena.style.removeProperty('height');
      const me = document.createElement('div');
      me.className = 'me-area'; me.textContent = 'My city and hand';
      arena.appendChild(me);
      const wr = document.querySelector('#opponents').getBoundingClientRect();
      const mr = me.getBoundingClientRect();
      return { fits: mr.top >= wr.bottom && arena.getBoundingClientRect().bottom >= mr.bottom,
        top: mr.top, bottom: mr.bottom, opponentsBottom: wr.bottom,
        arenaBottom: arena.getBoundingClientRect().bottom, style: getComputedStyle(me).cssText };
    });
    assert.ok(meFits.fits, 'Expanded draft arena keeps my city below the opponent panels: ' + JSON.stringify(meFits));
    const settledHeight = await page.locator('#opponents').evaluate(n => n.clientHeight);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#opponents').evaluate(n => n.clientHeight), settledHeight,
      'Observer must not continually increase the draft arena height');
    assert.deepEqual(errors, [], 'Layout observer must settle without browser errors');
    console.log(`Passed ${cases} desktop ring layouts, angular seats, content growth, and window resize.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
