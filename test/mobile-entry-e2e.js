/* Mobile entry regression: real pages and WebSockets, reference rules worker.
 * Run: node test/mobile-entry-e2e.js
 * Optional: PLAYWRIGHT_PATH, PYTHON_PATH, BROWSER_CHANNEL (default msedge).
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');

const root = path.join(__dirname, '..');
const serverCode = `
import asyncio, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, os.getcwd())
from python_backend.server import PythonServer
from python_backend.test_server import _ReferenceWorkerManager
async def main():
    with tempfile.TemporaryDirectory() as directory:
        os.environ['CITADELS_ADMIN_FILE'] = str(Path(directory) / 'admin.json')
        app = PythonServer(_ReferenceWorkerManager())
        server = await asyncio.start_server(app.handle, '127.0.0.1', 0)
        print('PORT=' + str(server.sockets[0].getsockname()[1]), flush=True)
        async with server:
            await server.serve_forever()
asyncio.run(main())
`;

async function main() {
  const server = spawn(process.env.PYTHON_PATH || path.join(root, '.python', 'python.exe'),
    ['-u', '-c', serverCode], { cwd: root, windowsHide: true });
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 15000);
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/PORT=(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      server.stderr.on('data', chunk => { output += chunk; });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + '\n' + output)); });
    });
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const errors = [];
    const pages = [];
    for (const name of ['host', 'guest']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(name + ': ' + error.message));
      await page.goto(`http://127.0.0.1:${port}/mobile.html`);
      assert.deepEqual(errors, [], 'Mobile script must finish initialization');
      assert.equal(await page.evaluate(() => typeof document.getElementById('lobby').onGameStart), 'function');
      await page.locator('#btn-online').click();
      await page.locator('#net-name').fill(name);
      pages.push(page);
    }
    const [host, guest] = pages;
    await host.locator('#net-players').selectOption('2');
    await host.locator('#btn-create').click();
    await host.locator('#r-code').filter({ hasText: /^[A-Z0-9]{4}$/ }).waitFor();
    const roomId = await host.locator('#r-code').textContent();
    await guest.locator('#net-code').fill(roomId);
    await guest.locator('#btn-join').click();
    await guest.locator('#r-code').filter({ hasText: roomId }).waitFor();
    await host.locator('#btn-net-start').click();
    for (const page of pages) {
      await page.locator('#entryOverlay').waitFor({ state: 'hidden' });
      await page.locator('#players .player-row').first().waitFor();
      assert.equal(await page.locator('#players .player-row').count(), 2);
    }
    console.log('PASS: host and guest enter the mobile game');
    await guest.locator('#menuButton').click();
    await guest.locator('#menuAutoHost').waitFor();
    const before = await guest.locator('#menuAutoHost').textContent();
    await guest.locator('#menuAutoHost').click();
    await guest.waitForFunction(text => document.getElementById('menuAutoHost').textContent !== text, before);
    console.log('PASS: guest can change disconnect hosting');
    await guest.reload();
    await guest.locator('#entryOverlay').waitFor({ state: 'hidden' });
    await guest.locator('#players .player-row').first().waitFor();
    assert.equal(await guest.locator('#players .player-row').count(), 2);
    assert.equal(await guest.evaluate(() => JSON.parse(localStorage.getItem('citadels.net.session')).roomId), roomId);
    console.log('PASS: guest refresh resumes the game without a stuck overlay');
    await guest.context().setOffline(true);
    await guest.locator('#entryOverlay').waitFor({ state: 'visible' });
    await guest.context().setOffline(false);
    await guest.locator('#entryOverlay').waitFor({ state: 'hidden' });
    assert.equal(await guest.locator('#players .player-row').count(), 2);
    assert.deepEqual(errors, [], 'No uncaught errors during entry or resume');
    console.log('PASS: guest reconnects after a network interruption');
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
