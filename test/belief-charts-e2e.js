'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const root=path.join(__dirname,'..'),publicRoot=path.join(root,'public');
const empty=()=>({state:'idle',running:false,runId:'test',completedGames:0,targetGames:1000,totalGames:0,samples:0,metrics:null,history:[],logs:[],checkpoints:[],inference:{configured:false}});
async function main(){
 const server=http.createServer((request,response)=>{
  const file=path.resolve(publicRoot,'.'+new URL(request.url,'http://localhost').pathname);
  if(!file.startsWith(publicRoot+path.sep)){response.writeHead(403);response.end();return;}
  fs.readFile(file,(error,data)=>{
   if(error){response.writeHead(404);response.end();return;}
   response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');response.end(data);
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  for(const width of [1280,390]){
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
   let state=empty();const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/api/belief/status',route=>route.fulfill({json:state}));
   await page.goto(`http://127.0.0.1:${server.address().port}/belief-training.html`);
   await page.locator('.belief-chart').last().waitFor();assert.equal(await page.locator('.belief-chart').count(),6);
   assert.equal(await page.locator('[data-chart=role] .belief-chart-point').count(),0);
   const history=[32,64,128,160,192].map((games,index)=>({games,loss:2-index*.3,validationJointNll:40-index*4,
    validationRoleNll:[null,0,1.4,null,.8][index],validationHandNll:null,trainSamples:128,validationSamples:index?32:0,updates:32}));
   state={...empty(),state:'training',running:true,totalGames:192,history,metrics:history.at(-1)};
   await page.evaluate(()=>refresh());
   await page.waitForFunction(()=>document.querySelectorAll('[data-chart=loss] .belief-chart-point').length===5);
   assert.equal(await page.locator('[data-chart=role] .belief-chart-point').count(),3);
   assert.equal(await page.locator('[data-chart=role] [data-value="0"]').count(),1);
   assert.equal(await page.locator('[data-chart=hand] .belief-chart-point').count(),0);
   const rolePath=await page.locator('[data-chart=role] path').getAttribute('d');
   assert.equal((rolePath.match(/M/g)||[]).length,2,'Missing validation points must break the curve');
   assert.ok(!/NaN|Infinity/.test(rolePath));
   const positions=await page.locator('[data-chart=loss] .belief-chart-point').evaluateAll(nodes=>nodes.map(n=>Number(n.getAttribute('cx'))));
   assert.ok(Math.abs((positions[2]-positions[1])/(positions[1]-positions[0])-2)<1e-5,'X axis must use game counts');
   await page.locator('[data-chart=role] [data-value="0"]').focus();
   assert.match(await page.locator('.belief-chart').nth(2).locator('.belief-chart-readout').textContent(),/64.*0\.0000/);
   await page.locator('[data-chart=role] [data-value="0.8"]').click();
   assert.match(await page.locator('.belief-chart').nth(2).locator('.belief-chart-readout').textContent(),/192.*0\.8000/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.setViewportSize({width:width===390?480:1100,height:900});
   await page.waitForFunction(()=>{const svg=document.querySelector('[data-chart=loss]');return Math.abs(svg.viewBox.baseVal.width-svg.clientWidth)<1;});
   await page.setViewportSize({width,height:900});
   await page.locator('#belief-charts').scrollIntoViewIfNeeded();
   fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
   await page.locator('#belief-charts').screenshot({path:path.join(root,`tmp/belief-charts-${width}.png`)});
   state={...state,runId:'single',history:[{games:1,loss:0,updates:0,trainSamples:1,validationSamples:0}]};
   await page.evaluate(()=>refresh());
   await page.waitForFunction(()=>document.querySelectorAll('[data-chart=loss] .belief-chart-point').length===1);
   assert.equal(await page.locator('[data-chart=loss] [data-value="0"]').count(),1);
   state={...empty(),runId:'new-run'};await page.evaluate(()=>refresh());
   await page.waitForFunction(()=>document.querySelectorAll('.belief-chart-point').length===0);
   assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Belief curves passed: desktop/mobile, updates, resize, gaps, zero/single points and new-run reset');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
