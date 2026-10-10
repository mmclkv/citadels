"""Public declarations stay visible without exposing hidden target markers."""
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MobilePublicEffectTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js required")
    def test_public_targets_lifetime_and_hidden_markers(self):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('public/app.js','utf8');
const context=vm.createContext({App:{}});
vm.runInContext(source.slice(source.indexOf('  function mobilePublicEffectItems('),
 source.indexOf('  function renderMobilePublicEffects(')),context);
const state={roomId:'ROOM',round:1,charDeck:[{num:4,name:'国王'},
 {id:'tax_collector',num:9,name:'税务官'}],effects:{assassinated:4,thief:5,bewitched:6,
 magistrate:{nums:[7,3,5],signed:7},blackmailer:{nums:[8,2],signed:8},taxCollectorGold:3}};
const texts=()=>context.mobilePublicEffectItems(state).map(item=>item.text);
let initial=JSON.stringify(texts());
assert(initial.includes('4 号·国王 被刺杀'));
assert(initial.includes('5 号 被盗贼盯上'));
assert(initial.includes('6 号 被施咒'));
assert(initial.includes('逮捕令 3 号、5 号、7 号'));
assert(initial.includes('威胁标记 2 号、8 号'));
assert(initial.includes('累计建筑税：3 枚金币'));
assert.deepEqual(state.effects.magistrate.nums,[7,3,5]);
state.effects.magistrate={nums:[5,7,3],signed:3};
state.effects.blackmailer={nums:[2,8],signed:2};
assert.equal(JSON.stringify(texts()),initial);
state.effects.thief=null;
assert(texts().some(t=>t==='5 号 被盗贼盯上（已生效）'));
state.effects.taxCollectorGold=0;
assert(texts().includes('累计建筑税：0 枚金币'));
state.effects={};state.charDeck=[];
state.round=2;assert.equal(texts().length,0);
state.effects={thief:5};assert.equal(texts().length,1);
state.roomId='NEW';state.effects={};assert.equal(texts().length,0);
'''
        result = subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
