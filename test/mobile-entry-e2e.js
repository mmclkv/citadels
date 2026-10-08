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
    for (const [route, entry] of [['mobile.html','btn-join'], ['index.html','btn-join'], ['mobile.html','btn-spectate'], ['index.html','btn-spectate']]) {
      const context = await browser.newContext({viewport:{width:route==='mobile.html'?390:1280,height:844}});
      const watcher = await context.newPage();
      watcher.on('pageerror', error => errors.push(route + ': ' + error.message));
      await watcher.addInitScript(() => {
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
              const msg = JSON.parse(event.data);
              if (msg.state) window.spectatorState = msg.state;
            });
          }
        };
      });
      await watcher.goto(`http://127.0.0.1:${port}/${route}`);
      await watcher.locator('#btn-online').click();
      // Same name as the host must still get an independent spectator identity.
      await watcher.locator('#net-name').fill('host');
      await watcher.locator('#net-code').fill(roomId);
      const originalSession = await host.evaluate(() => JSON.parse(localStorage.getItem('citadels.net.session')));
      if (entry === 'btn-spectate') {
        // An explicit watch request must not be overridden by an old player session.
        await watcher.evaluate(saved => localStorage.setItem('citadels.net.session', JSON.stringify(saved)), originalSession);
      }
      await watcher.locator('#'+entry).click();
      const selector = watcher.getByLabel('观战视角');
      await selector.waitFor();
      await watcher.waitForFunction(() => window.spectatorState?.spectating);
      const initial = await watcher.evaluate(() => window.spectatorState);
      assert.equal(initial.players.length, 2);
      assert.equal(initial.available.actions.length, 0);
      if (route === 'mobile.html') {
        const choosing = initial.players.find(p => p.id === initial.draft.currentPlayer);
        assert.equal(await watcher.locator('#selectedInfo').textContent(), choosing.name+'正在选角');
        assert.equal(await watcher.locator('#chooseTarget').count(), 0);
        if (initial.draft.pool.length) {
          assert.equal(await watcher.locator('#roleArea strong').textContent(), choosing.name+'正在选角');
          assert.equal((await watcher.locator('#roleArea .sub').textContent()).includes('/ 选择'), false);
          await watcher.locator('#roles [data-kind="role"]').first().click();
          assert.equal(await watcher.locator('#viewerConfirm').count(), 0);
          await watcher.locator('#viewerBack').click();
        }
      }
      const observerSession = await watcher.evaluate(() => JSON.parse(localStorage.getItem('citadels.net.session')));
      assert.notEqual(observerSession.token, originalSession.token, 'Joining under the same nickname must not receive the host resume token');
      const target = initial.players.find(p => p.id !== initial.viewPlayerId);
      await selector.selectOption(target.id);
      await watcher.waitForFunction(id => window.spectatorState.viewPlayerId === id, target.id);
      assert.equal(await selector.inputValue(), target.id);
      const switched = await watcher.evaluate(() => window.spectatorState);
      assert.equal(switched.you, target.id);
      assert.ok(switched.players.find(p=>p.id===target.id).hand.length);
      assert.equal(switched.players.find(p=>p.id!==target.id).hand, undefined);
      const first = initial.players.find(p => p.id === initial.viewPlayerId);
      const firstButton = watcher.getByRole('button', {name:`观战 ${first.name} 的视角`,exact:true});
      await firstButton.click();
      await watcher.waitForFunction(id => window.spectatorState.viewPlayerId === id, first.id);
      assert.equal(await firstButton.getAttribute('aria-pressed'), 'true');
      if (route === 'mobile.html') {
        const before = await selector.boundingBox();
        await watcher.locator('#viewport').evaluate(node => {node.scrollTop=node.scrollHeight;});
        const after = await selector.boundingBox();
        assert.equal(after.y, before.y, 'Mobile perspective controls must remain visible when the board scrolls');
        await watcher.locator(`#players [data-player="${target.id}"]`).click();
        await watcher.locator('#detailSpectate').click();
      } else {
        await watcher.getByRole('button', {name:`观战 ${target.name} 的视角`,exact:true}).click();
      }
      await watcher.waitForFunction(id => window.spectatorState.viewPlayerId === id, target.id);
      assert.equal(await selector.inputValue(), target.id);
      assert.equal(await watcher.evaluate(() => JSON.parse(localStorage.getItem('citadels.net.session')).token), observerSession.token);
      await watcher.reload();
      await selector.waitFor();
      assert.equal(await selector.inputValue(), target.id);
      if (route === 'mobile.html') {
        assert.equal(await watcher.locator('#actions button').count(), 0);
        await watcher.locator('#menuButton').click();
        assert.equal(await watcher.locator('#menuAutoHost').isHidden(), true);
        assert.equal(await watcher.locator('#menuSpeed').isHidden(), true);
        await watcher.locator('#menuClose').click();
      } else {
        await watcher.locator('#mobile-menu-toggle').click();
        assert.equal(await watcher.locator('#btn-chat').isHidden(), true);
        assert.equal(await watcher.locator('#btn-speed').isHidden(), true);
      }
      assert.equal(await selector.evaluate(node => {
        const r=node.getBoundingClientRect();
        return r.width>0 && r.left>=0 && r.right<=innerWidth;
      }), true, 'Perspective selector must fit the viewport');
      if (route === 'mobile.html') {
        await watcher.locator('#menuButton').click();
        await watcher.locator('#menuNewGame').click();
      } else {
        watcher.once('dialog', dialog => dialog.accept());
        await watcher.locator('#btn-back-home').click();
      }
      await watcher.locator('#btn-online').waitFor();
      assert.equal(await watcher.evaluate(() => localStorage.getItem('citadels.net.session')), null);
      await context.close();
      console.log('PASS: '+route+' '+entry+' joins as spectator, switches perspective, and resumes');
    }
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
