"""Public warrant ordering must never identify the first (real) target."""

import itertools
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend.views import sanitize
from test.python_game_reference import create_game


class PublicWarrantTests(unittest.TestCase):
    def test_public_view_does_not_expose_declaration_order(self):
        state = create_game({"seed": 1, "seats": [
            {"id": f"p{i}", "name": f"Player {i}"} for i in range(5)]})
        for order in itertools.permutations([3, 5, 7]):
            state["effects"]["magistrate"] = {
                "playerIdx": 0, "nums": list(order), "signed": order[0]}
            for viewer in ("p0", "p1", None):
                public = sanitize(state, viewer)["effects"]["magistrate"]
                self.assertEqual(public, {"playerIdx": 0, "nums": [3, 5, 7]})
            self.assertEqual(state["effects"]["magistrate"]["nums"], list(order))

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for mobile rendering checks")
    def test_mobile_banner_and_popup_ignore_real_target_order(self):
        # Execute the actual rendering functions, without connecting a browser/game.
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('public/mobile.js','utf8');
const context=vm.createContext({M:{},DECLARE_ROLES:new Set(),idxId:()=>null,seatName:()=>''});
vm.runInContext(source.slice(source.indexOf('  function effectItems()'),source.indexOf('  function renderEffects()'))+
 source.slice(source.indexOf('  const myHeldNums='),source.indexOf('  function noticeEvent(')),context);
const orders=[[7,3,5],[3,7,5],[5,3,7],[7,5,3],[3,5,7],[5,7,3]];
let expectedBanner,expectedPopup;
for(const nums of orders){
 const state={round:1,effects:{magistrate:{nums}},charDeck:[],players:[]};
 context.M.state=state;context.M.fxMemo=null;
 const banner=context.effectItems();
 const targets=nums.map(num=>({num,name:'角色'+num}));
 const notice={kind:'magistrate_declare',byName:'行政官',targets};
 const popup=context.noticeView(notice,state);
 const fallback=context.noticeView({...notice,targets:null,nums},state);
 if(!expectedBanner){expectedBanner=JSON.stringify(banner);expectedPopup=JSON.stringify(popup);}
 assert.strictEqual(JSON.stringify(banner),expectedBanner);
 assert.strictEqual(JSON.stringify(popup),expectedPopup);
 assert(fallback.text.indexOf('3 号')<fallback.text.indexOf('5 号'));
 assert(fallback.text.indexOf('5 号')<fallback.text.indexOf('7 号'));
 assert.deepStrictEqual(targets.map(t=>t.num),nums); // never mutate incoming data
 assert.deepStrictEqual(state.effects.magistrate.nums,nums);
 state.effects.magistrate=null;
 assert.strictEqual(JSON.stringify(context.effectItems()),expectedBanner); // remembered banner
}
'''
        result = subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
