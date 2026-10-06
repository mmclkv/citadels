"""Mobile chat messages appear inside the speaking player's board panel."""

from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MobileChatTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for mobile checks")
    def test_chat_routing_rendering_and_expiry(self):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('public/mobile.js','utf8');
let now=10000, timer, sidebarCalls=0;
const board={innerHTML:'',classList:{toggle(){}}};
const context=vm.createContext({
 M:{id:'me',state:{phase:'action',players:[
   {id:'me',name:'自己',city:[]},{id:'other',name:'对方',city:[]}]},bubbles:[],chat:[]},
 Date:{now:()=>now},setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){},
 $:()=>board,stageStep:()=>null,legal:()=>[],score:()=>({total:0}),
 coin:()=>'',points:()=>'',hand:()=>'',mini:()=>'',
 renderSidebar:()=>sidebarCalls++,render(){context.renderPlayers();}
});
function load(start,end){vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),context);}
load('  const esc =','  const cardKey =');
load('  function receive(msg)', '  function render()');
load('  function chatBubble(msg)', '  function processNotices(s)');
load('  function orderedPlayers(players)', '  function renderHand(own)');
function speak(playerId,text){context.receive({t:'chat',playerId,text});}
speak('other','<img src=x onerror=alert(1)>\n你好');
assert.strictEqual(sidebarCalls,1);
assert.strictEqual(context.M.chat.length,1);
const articles=board.innerHTML.match(/<article[\s\S]*?<\/article>/g);
assert(!articles[0].includes('tone-chat'));
assert(articles[1].includes('tone-chat enter'));
assert(articles[1].includes('&lt;img src=x onerror=alert(1)&gt;\n你好'));
assert(!articles[1].includes('<img'));
now+=1000;
speak('other','最新发言');
assert.strictEqual(context.M.bubbles.length,1);
const firstExpiry=context.M.bubbles[0].until;
now+=1000;
speak('other','最新发言'); // repeated text still refreshes the bubble
assert(context.M.bubbles[0].until>firstExpiry);
speak('me','长文本'.repeat(100));
assert.strictEqual(context.M.bubbles.length,2);
assert(board.innerHTML.includes('长文本'.repeat(100)));
const before=context.M.bubbles.length;
speak('spectator','旁观者');
assert.strictEqual(context.M.bubbles.length,before);
assert.strictEqual(context.M.chat.length,5);
now=context.M.bubbles[0].until-500;
timer();
assert(context.M.bubbles[0].fading);
now=50000;timer();
assert.strictEqual(context.M.bubbles.length,0);
assert(!board.innerHTML.includes('row-bubble'));
const css=fs.readFileSync('public/mobile-live.css','utf8');
assert(/\.row-bubble\.tone-chat\{position:relative/.test(css));
assert(css.includes('overflow-wrap:anywhere'));
'''
        result = subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
