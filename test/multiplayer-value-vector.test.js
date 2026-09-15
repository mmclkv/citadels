'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Search } = require('../training/mcts.js');
const train = require('../training/train.js');

function makeNode(playerId) {
  return { playerId, W: 0, WVector: new Float64Array(8), N: 0 };
}

test('4/5/6 人价值向量按相对座位排列，backup 不取负', () => {
  for (const count of [4, 5, 6]) {
    const search = Object.create(Search.prototype);
    search.playerOrder = Array.from({ length: count }, (_, i) => 'p' + i);
    search.vectorMode = true;
    const path = [makeNode('p0'), makeNode('p2')];
    const leafVector = new Float32Array(8);
    for (let i = 0; i < count; i++) leafVector[i] = 10 + i;
    search.backup(path, leafVector);
    assert.deepEqual(Array.from(path[0].WVector.slice(0, count)),
      Array.from({ length: count }, (_, rel) => 10 + ((rel - 2 + count) % count)),
      `${count} 人根节点必须得到根行动者视角向量`);
    assert.deepEqual(Array.from(path[1].WVector.slice(0, count)),
      Array.from({ length: count }, (_, rel) => 10 + rel),
      `${count} 人叶节点必须保留自己的行动者视角向量`);
    assert.equal(path[0].W, path[0].WVector[0], '兼容标量字段等于根玩家分量');
  }
});

test('4/5/6 人终局 reward vector 的 slot 0 是当前玩家奖励，其余 slot 使用相对座位', () => {
  for (const count of [4, 5, 6]) {
    const players = Array.from({ length: count }, (_, i) => ({ id: 'p' + i }));
    const state = { players, scores: players.map((_, i) => ({ playerIdx: i, total: count - i })) };
    const rewards = train.gameRewards(state);
    for (const perspective of players) {
      const vector = train.relativeRewardVector(state, perspective.id, rewards);
      assert.equal(vector.values.length, 8);
      assert.equal(vector.mask.slice(0, count).every(value => value === 1), true);
      assert.equal(vector.mask.slice(count).every(value => value === 0), true);
      for (let rel = 0; rel < count; rel++) {
        const id = players[(players.indexOf(perspective) + rel) % count].id;
        assert.equal(vector.values[rel], rewards.get(id));
      }
    }
  }
});
