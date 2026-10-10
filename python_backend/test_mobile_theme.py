"""The mobile classic skin must reuse actions and never reveal hidden card art."""
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MobileThemeTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js required")
    def test_missing_buildings_generate_complete_text_cards(self):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const ctx=vm.createContext({window:null,CitCards:require('./src/cards.js'),
 localStorage:{getItem:()=>null,setItem(){}},
 document:{documentElement:{setAttribute(){}},querySelectorAll:()=>[]}});
ctx.window=ctx;
for(const file of ['public/themes/neon/manifest.js','public/themes/theme-manager.js','public/mobile-theme.js'])
 vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
const T=ctx.CitadelThemeManager;
let missing=0;
for(const card of ctx.CitCards.DISTRICTS){
 const snapshot=JSON.stringify(card),hasArt=!!T.info('neon').cards.districts[T.districtKey(card)];
 for(const variant of ['thumb','full']){
  const asset=T.districtAsset(card,variant);
  if(hasArt){assert(!asset.startsWith('data:'));continue;}
  const svg=decodeURIComponent(asset.split(',').slice(1).join(','));
  const text=[...svg.matchAll(/<text[^>]*>(.*?)<\/text>/gs)].map(m=>m[1]).join('');
  assert(text.includes(card.name));assert(text.includes(card.desc),card.name);
  assert(text.includes('建造费用 '+card.cost+' 金币'));
  assert.strictEqual(ctx.CitadelMobileTheme.cardAsset('district',card,variant),asset);
  assert.strictEqual(T.districtAsset({...card},variant),asset);
 }
 if(!hasArt)missing++;
 assert.strictEqual(JSON.stringify(card),snapshot);
}
assert.strictEqual(missing,24);
const unsafe={name:'<script>&"',color:'purple',cost:0,desc:'测试 < & > 尾部说明'};
const svg=decodeURIComponent(T.districtTextAsset(unsafe).split(',').slice(1).join(','));
assert(svg.includes('&lt;script&gt;&amp;&quot;'));assert(!svg.includes('<script>'));
assert(svg.includes('测试 &lt; &amp; &gt; 尾部说明'));
'''
        result = subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js required")
    def test_card_art_and_saved_theme(self):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const saved=new Map([['citadels.ui.theme','classic'],['citadels.net.session','unchanged']]);
const ctx=vm.createContext({window:null,localStorage:{
 getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},
 document:{documentElement:{setAttribute(){}},querySelectorAll:()=>[]},
 CitCards:require('./src/cards.js'),CitadelThemeManifests:{neon:{id:'neon',cards:{
 roles:{assassin:{thumb:'/assassin-small.png',full:'/assassin-full.png'}},
 districts:{district_temple:{thumb:'/temple-small.png',full:'/temple-full.png'}}}}}});
ctx.window=ctx;
vm.runInContext(fs.readFileSync('public/themes/theme-manager.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('public/mobile-theme.js','utf8'),ctx);
assert.strictEqual(ctx.CitadelThemeManager.current,'classic');
const art=ctx.CitadelMobileTheme.cardAsset;
const svg=(kind,card,variant)=>decodeURIComponent(art(kind,card,variant).split(',').slice(1).join(','));
const input={id:'assassin',name:'刺客',num:1};
const before=JSON.stringify(input);
assert(svg('role',input,'full').includes('说出一个你要刺杀的角色编号'));
assert.strictEqual(JSON.stringify(input),before);
const temple={name:'神庙',en:'Temple',cost:1,color:'blue'};
assert(svg('district',temple).includes('宗教建筑'));
assert(svg('district',temple).includes('建造费用 1 金币'));
assert.strictEqual(art('district',temple),art('district',{...temple}));
assert(svg('district',{name:'<script>&"',cost:2}).includes('&lt;script&gt;&amp;&quot;'));
assert(!svg('district',{name:'<script>&"',cost:2}).includes('<script>'));
const hidden=svg('back',input,'full');
assert(hidden.includes('身份未公开'));
assert(!hidden.includes('刺客'));
ctx.CitadelThemeManager.toggle();
assert.strictEqual(saved.get('citadels.ui.theme'),'neon');
assert.strictEqual(saved.get('citadels.net.session'),'unchanged');
assert.strictEqual(art('role',input),'/assassin-small.png');
assert.strictEqual(art('role',input,'full'),'/assassin-full.png');
assert.strictEqual(art('district',temple),'/temple-small.png');
assert.strictEqual(art('back'),'./assets/themes/neon/card-back.png');
assert(art('role',{id:'missing',name:'新角色',num:9}).startsWith('data:image/svg+xml'));
ctx.CitadelThemeManager.toggle();
assert.strictEqual(art('role',input),art('role',input));
'''
        subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT, check=True)

    @unittest.skipUnless(shutil.which("node"), "Node.js required")
    def test_switch_repaints_without_sending_or_resetting_selection(self):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('public/mobile.js','utf8');
const nodes=new Map();
const element=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:'',innerHTML:''});return nodes.get(id);};
let changed,theme='classic',renders=0,viewers=0;
const state={available:{actions:[{type:'choose_char',num:5}]}};
const selected={type:'museum',uids:new Set(['d1'])};
const preview={kind:'role',card:{name:'主教',num:5},confirm:state.available.actions[0],stageOption:0};
const context=vm.createContext({
 $:element,esc:x=>x,T:{is:id=>id===theme,label:()=>theme,
  onChange:fn=>changed=fn,toggle:()=>{theme=theme==='classic'?'neon':'classic';changed();}},
 M:{state,selection:selected,viewer:preview,stage:{surface:'role'},ws:{readyState:1}},
 render:()=>renders++,openViewer:(...args)=>{assert.strictEqual(args[2],preview.confirm);viewers++;},
 send:()=>{throw Error('Theme change must not send a game action');},
});
vm.runInContext(source.slice(source.indexOf('  function syncTheme()'),source.indexOf('  const leaveToLobby=')),context);
const snapshot=JSON.stringify(state);
element('menuTheme').onclick();
assert.strictEqual(renders,1);assert.strictEqual(viewers,1);
assert.strictEqual(context.M.state,state);assert.strictEqual(context.M.selection,selected);
assert.strictEqual(context.M.viewer,preview);assert.strictEqual(JSON.stringify(state),snapshot);
assert(element('menuTheme').textContent.includes('霓虹'));
assert(!source.includes("T.apply('neon', { persist: false })"));
'''
        subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT, check=True)

    def test_assets_are_loaded_and_cached_in_order(self):
        html = (ROOT / "public/mobile.html").read_text(encoding="utf-8")
        self.assertLess(html.index("themes/theme-manager.js"), html.index("mobile-theme.js"))
        self.assertLess(html.index("mobile-theme.js"), html.index("./mobile.js"))
        self.assertIn('id="menuTheme"', html)
        sw = (ROOT / "public/sw.js").read_text(encoding="utf-8")
        self.assertIn("'./mobile-theme.js'", sw)
        self.assertIn("'./themes/classic/mobile.css'", sw)

    def test_local_card_art_bypasses_network_preloading(self):
        source = (ROOT / "public/mobile.js").read_text(encoding="utf-8")
        self.assertIn("if(url.startsWith('data:')) return url;", source)
        self.assertNotIn("warmFullImage(", source)
        self.assertIn("if(card)artSrc(kind==='role'?roleImg(card,'full'):districtImg(card,'full'))", source)

    def test_classic_css_is_scoped_and_does_not_change_layout(self):
        css = (ROOT / "public/themes/classic/mobile.css").read_text(encoding="utf-8")
        for rule in css.split("}"):
            if "{" in rule:
                self.assertIn('[data-theme="classic"]', rule.split("{")[0])
        for prop in ("grid-template-columns:", "display:", "position:", "overflow:"):
            self.assertNotIn(prop, css)
        self.assertIn("color-scheme:light", css)
        for selector in (".player-row", ".sidebar-chat-form input", ".event-box", ".viewer", ".row-bubble", ".score-table"):
            self.assertIn(selector, css)


if __name__ == "__main__":
    unittest.main()
