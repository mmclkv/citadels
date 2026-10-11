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
  const server = spawn(process.env.PYTHON_PATH || path.join(root, '.python', 'python.exe'), ['-u', '-c', serverCode], {cwd:root, windowsHide:true});
  let browser;
  try {
    const port = await new Promise((resolve,reject) => {
      let output='';
      const timer=setTimeout(()=>reject(new Error(output || 'server timeout')),20000);
      server.stdout.on('data',c=>{output+=c; const m=output.match(/PORT=(\d+)/); if(m){clearTimeout(timer);resolve(Number(m[1]));}});
      server.stderr.on('data',c=>{output+=c;});
    });
    browser=await chromium.launch({channel:'msedge',headless:true});
    for (const entry of ['index.html','mobile.html']) {
      const context=await browser.newContext({viewport:{width:entry==='mobile.html'?390:1280,height:900}});
      const page=await context.newPage();
      const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}/${entry}`);
      await page.locator('#btn-single').click();
      await page.locator('#cfg-search-time').waitFor({state:'visible'});
      assert.equal(await page.locator('#cfg-mcts-sims').isVisible(),false);
      await page.locator('#cfg-advanced-toggle').click();
      await page.locator('#cfg-mcts-sims').waitFor({state:'visible'});
      await page.locator('#cfg-mcts-sims').fill('50');
      await page.locator('#cfg-advanced-toggle').click();
      assert.equal(await page.locator('#cfg-mcts-sims').isVisible(),false);
      assert.equal(await page.locator('#cfg-mcts-sims').inputValue(),'50');
      await page.locator('#cfg-bot-type').selectOption('neural');
      assert.equal(await page.locator('#cfg-search-time').isVisible(),true);
      assert.equal(await page.locator('#cfg-mcts-sims').isVisible(),false);
      await page.locator('#cfg-advanced-toggle').click();
      assert.equal(await page.locator('#cfg-mcts-sims').inputValue(),'5000');
      await page.locator('#cfg-bot-type').selectOption('agent');
      assert.equal(await page.locator('#cfg-search-time').isVisible(),false);
      assert.equal(await page.locator('#cfg-mcts-sims').isVisible(),false);
      await page.reload();
      await page.locator('#btn-online').click();
      await page.locator('#net-players').selectOption('2');
      await page.locator('#btn-create').click();
      const seat=page.locator('#seat-grid .seat').nth(1);
      await seat.getByRole('button',{name:'设为电脑',exact:true}).click();
      await seat.locator('.search-budget input').waitFor({state:'visible'});
      assert.equal(await seat.locator('.mcts-advanced input').first().isVisible(),false);
      await seat.getByRole('button',{name:'高级选项',exact:true}).click();
      await seat.locator('.mcts-advanced input').first().fill('120');
      await seat.locator('.mcts-advanced input').first().blur();
      await page.waitForFunction(()=>document.querySelector('c-citadels-lobby').shadowRoot.querySelector('#seat-grid .seat:nth-child(2) .mcts-advanced input').value==='120');
      assert.equal(await seat.locator('.mcts-advanced input').first().isVisible(),true);
      await seat.locator('.search-budget input').fill('250');
      await seat.locator('.search-budget input').blur();
      await page.waitForTimeout(300);
      assert.equal(await seat.locator('.search-budget input').inputValue(),'250');
      assert.equal(await seat.locator('.mcts-advanced input').first().inputValue(),'120');
      await seat.getByRole('button',{name:'收起高级选项',exact:true}).click();
      assert.equal(await seat.locator('.mcts-advanced input').first().isVisible(),false);
      await seat.locator('select').selectOption('neural');
      await seat.locator('.search-budget input').waitFor({state:'visible'});
      assert.equal(await seat.locator('.mcts-advanced input').first().isVisible(),false);
      await seat.getByRole('button',{name:'高级选项',exact:true}).click();
      await seat.locator('.mcts-advanced input').nth(1).fill('30');
      await seat.locator('.mcts-advanced input').nth(1).blur();
      await page.waitForTimeout(300);
      assert.equal(await seat.locator('.mcts-advanced input').nth(1).inputValue(),'30');
      assert.equal(await seat.locator('.mcts-advanced input').first().isVisible(),true);
      assert.deepEqual(errors,[]);
      await context.close();
    }
    console.log('Lobby search options passed on desktop and mobile');
  } finally {if(browser)await browser.close();server.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
