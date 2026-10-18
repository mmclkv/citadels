'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const root=path.join(__dirname,'..');
fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
const engine=process.env.CITADELS_BELIEF_GAME_ENGINE || fs.readdirSync(path.join(root,'native')).filter(n=>/^game_engine-.*\.exe$/.test(n)).map(n=>path.join(root,'native',n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
if(!engine)throw new Error('Set CITADELS_BELIEF_GAME_ENGINE to a compiled game engine');
const code=`
import asyncio,os,sys,tempfile
from pathlib import Path
sys.path.insert(0,os.getcwd())
import torch
torch.set_num_threads(1)
from python_backend.server import PythonServer
from python_backend.test_server import _ReferenceWorkerManager
async def main():
 with tempfile.TemporaryDirectory() as directory:
  os.environ['CITADELS_ADMIN_FILE']=str(Path(directory)/'admin.json')
  os.environ['CITADELS_TRAINING_DATA_DIR']=directory
  app=PythonServer(_ReferenceWorkerManager())
  app.belief_training.engine_path=os.environ['CITADELS_BELIEF_GAME_ENGINE']
  server=await asyncio.start_server(app.handle,'127.0.0.1',0)
  print('PORT='+str(server.sockets[0].getsockname()[1]),flush=True)
  async with server:await server.serve_forever()
asyncio.run(main())
`;
async function main(){
 const server=spawn(process.env.PYTHON_PATH || path.join(root,'.python','python.exe'),['-u','-c',code],{cwd:root,windowsHide:true,env:{...process.env,CITADELS_BELIEF_GAME_ENGINE:engine,OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{
   let output='';const timer=setTimeout(()=>reject(new Error(output || 'startup timeout')),30000);
   server.stdout.on('data',c=>{output+=c;const match=output.match(/PORT=(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
   server.stderr.on('data',c=>output+=c);
   server.on('exit',()=>{clearTimeout(timer);reject(new Error(output));});
  });
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  for(const width of [1280,390]){
   const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:${port}/training.html`);
   await page.getByRole('link',{name:'信念网络训练',exact:true}).click();
   await page.getByRole('heading',{name:'信念网络训练',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   const values={targetGames:4,minPlayers:4,maxPlayers:4,batchGames:2,checkpointEvery:2,historyLength:8,samplesPerGame:3,sampleEvery:10,updateSamples:2,miniBatch:1,validationEvery:2,replayGames:8};
   for(const [name,value] of Object.entries(values))await page.locator(`[name="${name}"]`).fill(String(value));
   for(const [name,value] of Object.entries({dimension:'64',opponents:'heuristic',charSet:'base'}))await page.locator(`[name="${name}"]`).selectOption(value);
   const readStatus=async()=>await (await page.request.get(`http://127.0.0.1:${port}/api/belief/status`)).json();
   const until=async predicate=>{
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){const s=await readStatus();if(s.state==='error')throw new Error(s.error);if(predicate(s))return s;await page.waitForTimeout(100);}
    throw new Error('Belief lifecycle timed out');
   };
   const previousRun=(await readStatus()).runId;
   await page.locator('#start').click();
   const state=await until(s=>s.runId!==previousRun&&s.state==='completed'&&s.checkpoint);
   assert.ok(state.metrics && state.metrics.validationSamples>0,JSON.stringify(state));assert.equal(state.completedGames,4);
   await page.locator('#checkpoint').selectOption(state.checkpoint);
   await page.locator('#activate').click();
   await until(s=>s.inference.configured);
   await page.locator('#disable').click();
   await until(s=>!s.inference.configured);
   await page.screenshot({path:path.join(root,`tmp/belief-training-${width}.png`),fullPage:true});
   assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Belief training desktop/mobile collection, validation, checkpoints, activation and disable passed');
 }finally{if(browser)await browser.close();server.kill();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
