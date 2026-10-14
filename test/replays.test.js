const assert=require('node:assert/strict');const test=require('node:test');require('../public/replays.js');
test('replay nested edits and append match server delta format',()=>{const a={players:[{gold:1}],logs:[],gone:1};const b=CitReplay.applyDelta(a,[[0,['players',0,'gold'],3],[2,['logs'],['event']],[1,['gone']]]);assert.deepEqual(b,{players:[{gold:3}],logs:['event']});});
test('replay rejects prototype pollution',()=>{assert.throws(()=>CitReplay.applyDelta({},[[0,['__proto__','unsafe'],true]]));assert.equal({}.unsafe,undefined);});
