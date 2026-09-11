/* Optional real-browser smoke test: requires Playwright and Chromium. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture, until } = require('./agent-harness.js');
(async () => {
  const f = await fixture();
  const disabled = await fixture(false);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(disabled.base);
    // Card hover/bobbing effects animate continuously; disable motion for click stability.
    await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' });
    await page.click('#btn-single');
    await page.selectOption('#cfg-bot-type', 'agent');
    await page.click('#btn-start-single');
    await page.waitForFunction(() => document.querySelector('#cfg-agent-status').textContent.includes('尚未配置'));
    assert(await page.locator('#screen-setup').evaluate(e => e.classList.contains('active')));
    // Exercise cross-origin Pages -> game server configuration and the single-player route.
    await page.fill('#cfg-server', f.base); await page.locator('#cfg-server').dispatchEvent('change');
    f.mock.mode = 'error'; f.mock.delay = 200;
    await page.click('#btn-start-single');
    await page.waitForFunction(() => window.__CitadelsApp.state && window.__CitadelsApp.state.phase === 'draft');
    assert.equal(await page.evaluate(() => window.__CitadelsApp.mode), 'net');
    assert.equal(await page.evaluate(() => window.__CitadelsApp.__local.state), null);
    await page.locator('#draft-pool .char-card').first().click();
    await page.waitForFunction(() => document.querySelector('#prompt').textContent.includes('正在请求模型'));
    await page.waitForSelector('#actions button:has-text("重试模型")');
    assert.match(await page.locator('#prompt').textContent(), /401/);
    f.mock.mode = 'ok';
    await page.click('#actions button:has-text("重试模型")');
    await until(() => f.mock.requests.length >= 2, 'retry model from UI');
    await page.waitForFunction(() => window.__CitadelsApp.state.players[1].hasChosen);
    // Reload reconstructs the same server-backed room, not a local NPC simulation.
    const id = await page.evaluate(() => window.__CitadelsApp.myId);
    await page.reload();
    await page.waitForFunction(id => window.__CitadelsApp.myId === id && window.__CitadelsApp.state, id);
    assert.equal(await page.evaluate(() => window.__CitadelsApp.state.players[1].botType), 'agent');
    // A separate browser context can still play normal offline NPC games.
    const normal = await browser.newPage({ serviceWorkers: 'block' });
    normal.on('pageerror', e => errors.push(e.message));
    await normal.goto(disabled.base);
    await normal.click('#btn-single');
    await normal.click('#btn-start-single');
    await normal.waitForFunction(() => window.__CitadelsApp.state && window.__CitadelsApp.state.phase === 'draft');
    assert.equal(await normal.evaluate(() => window.__CitadelsApp.mode), 'local');
    assert.deepEqual(errors, []);
    console.log('PASS browser: missing config, cross-origin server, Agent single player, thinking/error/retry UI, reload and ordinary NPC');
  } finally {
    if (browser) await browser.close();
    await f.close(); await disabled.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
