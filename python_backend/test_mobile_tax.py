"""Mobile public board displays the live construction tax balance."""

from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MobileTaxTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for mobile rendering checks")
    def test_tax_balance_updates_and_only_appears_with_collector(self):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('public/mobile.js','utf8');
const context=vm.createContext({M:{}});
vm.runInContext(source.slice(source.indexOf('  function effectItems()'),
 source.indexOf('  function renderEffects()')),context);
const s={round:1,effects:{taxCollectorGold:0},charDeck:[{id:'tax_collector'}]};
context.M.state=s;
assert.strictEqual(context.effectItems()[0].text,'累计建筑税：0 枚金币');
s.effects.taxCollectorGold=7;
assert.strictEqual(context.effectItems()[0].text,'累计建筑税：7 枚金币');
s.effects.taxCollectorGold=0; // collected within the same round
assert.strictEqual(context.effectItems()[0].text,'累计建筑税：0 枚金币');
s.round=2;s.effects.taxCollectorGold=3;
assert.strictEqual(context.effectItems()[0].text,'累计建筑税：3 枚金币');
s.charDeck=[{id:'queen'}];
assert.strictEqual(context.effectItems().length,0);
'''
        result = subprocess.run([shutil.which("node"), "-e", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
