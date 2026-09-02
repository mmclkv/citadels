/* =========================================================================
 * 富饶之城 / 荣耀之城 (Citadels) — 卡牌与角色数据
 * 数据来源：https://andyventure.com/boardgame-citadels/
 *           https://andyventure.com/boardgame-citadels-characters/
 * 可在 Node 与浏览器中同时加载（UMD 风格）
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CitCards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ----------------------------- 建筑颜色 ----------------------------- */
  const COLORS = {
    yellow: { key: 'yellow', name: '皇家', en: 'Noble',    hex: '#e0a92b', incomeChar: 4 },
    blue:   { key: 'blue',   name: '宗教', en: 'Religious', hex: '#3d7ec4', incomeChar: 5 },
    green:  { key: 'green',  name: '商业', en: 'Trade',     hex: '#3fa46a', incomeChar: 6 },
    red:    { key: 'red',    name: '军事', en: 'Military',  hex: '#d0503f', incomeChar: 8 },
    purple: { key: 'purple', name: '独特', en: 'Special',   hex: '#8b5cc7', incomeChar: 0 }
  };
  const COLOR_ORDER = ['yellow', 'blue', 'green', 'red', 'purple'];

  /* ----------------------------- 建筑牌定义 -----------------------------
   * purple.effect 用于引擎识别紫色建筑的特殊能力
   *   keepBoth      图书馆：抽牌行动时两张都留下
   *   draw3keep1    天文台：抽牌行动时抽3留1
   *   scoreAs       巨龙门/大学：计分时按 scoreAs 分计算
   *   anyColorScore 鬼城：计分时视为任意颜色
   *   anyColorIncome 魔法学院：收入时视为任意颜色
   *   smithy        铁匠铺：付2金抽3张（每回合一次）
   *   lab           实验室：弃1张手牌换1金（每回合一次）
   *   immune        堡垒：不可被领主摧毁
   *   wallCost      长城：领主摧毁你其它建筑多付1金
   *   graveyard     墓地：领主摧毁建筑时付1金将其收入手牌
   *   quarry        采石场：可建造同名的第二栋
   *   museum        博物馆：每回合可将1张手牌放在其下，计分时每张+1
   * ------------------------------------------------------------------- */
  const DISTRICTS = [
    /* ---------- 黄色 · 皇家建筑 12 张（4号角色收入） ---------- */
    { name: '庄园',   en: 'Manor',   color: 'yellow', cost: 3, count: 5 },
    { name: '城堡',   en: 'Castle',  color: 'yellow', cost: 4, count: 4 },
    { name: '宫殿',   en: 'Palace',  color: 'yellow', cost: 5, count: 3 },

    /* ---------- 蓝色 · 宗教建筑 11 张（5号角色收入） ---------- */
    { name: '神庙',   en: 'Temple',     color: 'blue', cost: 1, count: 3 },
    { name: '教堂',   en: 'Church',     color: 'blue', cost: 2, count: 3 },
    { name: '修道院', en: 'Monastery',  color: 'blue', cost: 3, count: 3 },
    { name: '大教堂', en: 'Cathedral',  color: 'blue', cost: 5, count: 2 },

    /* ---------- 绿色 · 商业建筑 20 张（6号角色收入） ---------- */
    { name: '酒馆',   en: 'Tavern',       color: 'green', cost: 1, count: 5 },
    { name: '集市',   en: 'Market',       color: 'green', cost: 2, count: 4 },
    { name: '商栈',   en: 'Trading Post', color: 'green', cost: 2, count: 3 },
    { name: '船坞',   en: 'Docks',        color: 'green', cost: 3, count: 3 },
    { name: '港口',   en: 'Harbor',       color: 'green', cost: 4, count: 3 },
    { name: '市政厅', en: 'Town Hall',    color: 'green', cost: 5, count: 2 },

    /* ---------- 红色 · 军事建筑 11 张（8号角色收入） ---------- */
    { name: '了望塔', en: 'Watchtower',  color: 'red', cost: 1, count: 3 },
    { name: '监狱',   en: 'Prison',      color: 'red', cost: 2, count: 3 },
    { name: '战场',   en: 'Battlefield', color: 'red', cost: 3, count: 3 },
    { name: '要塞',   en: 'Fortress',    color: 'red', cost: 5, count: 2 },

    /* ---------- 紫色 · 独特建筑 14 张（基本版） ---------- */
    { name: '鬼城', en: 'Ghost Town', color: 'purple', cost: 2, count: 1,
      purple: { effect: 'anyColorScore' },
      desc: '计分时鬼城可视为任意一种颜色（若在最后一轮才建成则不可使用）。' },
    { name: '堡垒', en: 'Keep', color: 'purple', cost: 3, count: 2,
      purple: { effect: 'immune' },
      desc: '堡垒不会被领主/外交官摧毁或交换。' },
    { name: '博物馆', en: 'Museum', color: 'purple', cost: 4, count: 1,
      purple: { effect: 'museum' },
      desc: '你的回合中可将1张手牌面朝下放到博物馆下；计分时其下每张牌+1分。' },
    { name: '墓地', en: 'Graveyard', color: 'purple', cost: 5, count: 1,
      purple: { effect: 'graveyard' },
      desc: '当领主摧毁一栋建筑时，你可支付1枚金币将被摧毁的建筑收入手牌（若你本人是领主则不可用）。' },
    { name: '实验室', en: 'Laboratory', color: 'purple', cost: 5, count: 1,
      purple: { effect: 'lab' },
      desc: '你的回合中可弃掉1张手牌换取1枚金币，每回合限一次。' },
    { name: '铁匠铺', en: 'Smithy', color: 'purple', cost: 5, count: 1,
      purple: { effect: 'smithy' },
      desc: '你的回合中可支付2枚金币抽3张建筑牌，每回合限一次。' },
    { name: '天文台', en: 'Observatory', color: 'purple', cost: 5, count: 1,
      purple: { effect: 'draw3keep1' },
      desc: '若选择抽牌作为行动，则抽3张留1张，其余2张放回牌堆底。' },
    { name: '图书馆', en: 'Library', color: 'purple', cost: 6, count: 1,
      purple: { effect: 'keepBoth' },
      desc: '若选择抽牌作为行动，抽到的2张都可保留。' },
    { name: '魔法学院', en: 'School of Magic', color: 'purple', cost: 6, count: 1,
      purple: { effect: 'anyColorIncome' },
      desc: '计算角色收入时，魔法学院可视为任意一种颜色（收入+1）。' },
    { name: '巨龙门', en: 'Dragon Gate', color: 'purple', cost: 6, count: 1,
      purple: { effect: 'scoreAs', scoreAs: 8 },
      desc: '建造花费6金，但计分时价值8分。' },
    { name: '大学', en: 'University', color: 'purple', cost: 6, count: 1,
      purple: { effect: 'scoreAs', scoreAs: 8 },
      desc: '建造花费6金，但计分时价值8分。' },
    { name: '长城', en: 'Great Wall', color: 'purple', cost: 6, count: 1,
      purple: { effect: 'wallCost' },
      desc: '领主摧毁你的其它建筑时需多支付1枚金币。' },
    { name: '采石场', en: 'Quarry', color: 'purple', cost: 5, count: 1,
      purple: { effect: 'quarry' },
      desc: '你城市中每种建筑可以多建造一栋同名建筑。' }
  ];

  /* ----------------------------- 角色定义 -----------------------------
   * num        行动顺序编号
   * income     收入颜色（yellow/blue/green/red）
   * drawBonus  领取资源时额外抽取的建筑牌数量
   * goldBonus  领取资源时额外获得的金币数量
   * buildLimit 本回合可建造的建筑数量上限
   * noBuild    本回合不可建造
   * noTarget   不需要指定目标
   * twoPlayerBan / smallBan 使用限制
   * ------------------------------------------------------------------- */
  const CHARACTERS = [
    /* ============ 1 号 ============ */
    { id: 'assassin', num: 1, name: '刺客', en: 'Assassin', version: 'base',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '说出一个你要刺杀的角色编号。该角色被叫到时必须保持沉默、不翻开角色牌，直接跳过整个回合（轮末才公开）。',
      hint: '选择要刺杀的角色编号' },

    { id: 'witch', num: 1, name: '女巫', en: 'Witch', version: 'dark',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '领取资源后，说出一个角色编号对其施咒并结束自己的回合。被施咒者被叫到时只能领取资源，随后女巫接管其剩余行动（可使用其能力与建造）。建筑物的能力不受女巫控制。',
      hint: '选择要施咒的角色编号' },

    /* ============ 2 号 ============ */
    { id: 'thief', num: 2, name: '盗贼', en: 'Thief', version: 'base',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '说出一个你要偷窃的角色编号。该角色被叫到并公开时，须把全部金币交给盗贼。不可偷窃1号角色、被刺杀者和被施咒者。',
      hint: '选择要偷窃的角色编号' },

    /* ============ 3 号 ============ */
    { id: 'magician', num: 3, name: '魔术师', en: 'Magician', version: 'base',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '二选一：①与一位玩家交换全部手牌（即使一方没有手牌也可交换）；②将手中任意数量的建筑牌放到牌堆底，再抽等量新牌。',
      hint: '选择一种能力' },

    { id: 'prophet', num: 3, name: '预言家', en: 'Prophet', version: 'deluxe',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 2,
      desc: '从每位对手手上各抽1张建筑牌，然后任意还给每人1张（对方没手牌则不必还）。本回合可建造2栋建筑。',
      hint: '预言家：抽取对手手牌' },

    /* ============ 4 号 ============ */
    { id: 'king', num: 4, name: '国王', en: 'King', version: 'base',
      income: 'yellow', drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋皇家（黄）建筑获得1金。轮到你时立刻获得【皇冠】并由你叫号。若国王被刺杀，轮末翻开角色牌仍然获得皇冠。',
      hint: '国王：领取皇家建筑收入' },

    { id: 'emperor', num: 4, name: '皇帝', en: 'Emperor', version: 'dark',
      income: 'yellow', drawBonus: 0, goldBonus: 0, buildLimit: 1, twoPlayerBan: true,
      desc: '每有1栋皇家（黄）建筑获得1金。必须将皇冠交给另一位玩家，并从新皇冠持有者处拿取1枚金币或1张手牌。',
      hint: '皇帝：转移皇冠' },

    { id: 'noble', num: 4, name: '贵族', en: 'Noble', version: 'deluxe',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋皇家（黄）建筑抽取1张建筑牌。轮到你时立刻获得【皇冠】。',
      hint: '贵族：领取皇家建筑收入' },

    /* ============ 5 号 ============ */
    { id: 'bishop', num: 5, name: '主教', en: 'Bishop', version: 'base',
      income: 'blue', drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋宗教（蓝）建筑获得1金。你的城市不会被8号角色摧毁（但被刺杀/被施咒后则失去此保护）。',
      hint: '主教：领取宗教建筑收入' },

    { id: 'monk', num: 5, name: '修士', en: 'Monk', version: 'dark',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋宗教（蓝）建筑获得1金或抽1张牌（须先宣告组合）。回合中若有人金币比你多，可从最富有者处拿1金。',
      hint: '修士：宣告要领取的资源组合' },

    /* ============ 6 号 ============ */
    { id: 'merchant', num: 6, name: '商人', en: 'Merchant', version: 'base',
      income: 'green', drawBonus: 0, goldBonus: 1, buildLimit: 1,
      desc: '每有1栋商业（绿）建筑获得1金。无论选择哪种资源，都额外获得1枚金币。',
      hint: '商人：领取商业建筑收入' },

    { id: 'alchemist', num: 6, name: '炼金术士', en: 'Alchemist', version: 'dark',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '本回合结束时，取回你花在建筑上的全部金币（不含其它开销）。',
      hint: '炼金术士：回合结束时回收建造花费' },

    { id: 'businessman', num: 6, name: '生意人', en: 'Businessman', version: 'deluxe',
      income: 'green', drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋商业（绿）建筑获得1金。你的绿色建筑不受建造限额限制（可建任意数量绿建 + 1栋非绿建筑）。',
      hint: '生意人：领取商业建筑收入' },

    /* ============ 7 号 ============ */
    { id: 'architect', num: 7, name: '建筑师', en: 'Architect', version: 'base',
      income: null, drawBonus: 2, goldBonus: 0, buildLimit: 3,
      desc: '无论选择哪种资源，额外再抽2张建筑牌。本回合最多可建造3栋建筑。',
      hint: '建筑师：可建造最多3栋' },

    { id: 'navigator', num: 7, name: '航海家', en: 'Navigator', version: 'dark',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 0,
      desc: '无论选择哪种资源，额外再拿4枚金币或抽4张建筑牌。但本回合不可建造任何建筑。',
      hint: '航海家：选择额外奖励' },

    { id: 'scholar', num: 7, name: '学者', en: 'Scholar', version: 'deluxe',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 2,
      desc: '从建筑牌堆抽7张，选1张加入手牌，其余6张放回牌堆并重洗。本回合可建造2栋建筑。',
      hint: '学者：从7张中选1张' },

    /* ============ 8 号 ============ */
    { id: 'warlord', num: 8, name: '领主', en: 'Warlord', version: 'base',
      income: 'red', drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋军事（红）建筑获得1金。可支付「建筑费用-1」枚金币摧毁任意一栋建筑。无法摧毁已达到结束建筑数的玩家的城市。',
      hint: '领主：摧毁一栋建筑' },

    { id: 'diplomat', num: 8, name: '外交官', en: 'Diplomat', version: 'dark',
      income: 'red', drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋军事（红）建筑获得1金。回合结束时可与一位玩家交换一栋建筑，若换来的建筑更贵须付差额。堡垒不可被交换。',
      hint: '外交官：交换建筑' },

    { id: 'marshal', num: 8, name: '元帅', en: 'Marshal', version: 'deluxe',
      income: 'red', drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '每有1栋军事（红）建筑获得1金。可抢走其他玩家费用3以下的建筑，并支付同额金币给该玩家。不可抢夺已达标玩家的建筑。',
      hint: '元帅：抢夺建筑' },

    /* ============ 9 号 ============ */
    { id: 'queen', num: 9, name: '皇后', en: 'Queen', version: 'dark',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1, smallBan: 5,
      desc: '若你的座位与持有4号角色的玩家相邻，可获得3枚金币。（4号被刺杀时轮末确认后同样可获得）',
      hint: '皇后：座位与4号相邻时+3金' },

    { id: 'artist', num: 9, name: '艺术家', en: 'Artist', version: 'dark',
      income: null, drawBonus: 0, goldBonus: 0, buildLimit: 1,
      desc: '美化建筑：将1枚金币放在已建成的建筑上，计分时该建筑+1分。每回合最多美化2栋，每栋只能被美化一次。',
      hint: '艺术家：美化最多2栋建筑' }
  ];

  const CHAR_MAP = {};
  CHARACTERS.forEach(c => { CHAR_MAP[c.id] = c; });

  /* ----------------------------- 工具函数 ----------------------------- */

  /** 生成一副完整的建筑牌堆（每张牌带唯一 uid） */
  function buildDistrictDeck(seedRandom) {
    const rnd = seedRandom || Math.random;
    const cards = [];
    let uid = 0;
    DISTRICTS.forEach(def => {
      for (let i = 0; i < def.count; i++) {
        cards.push({
          uid: 'd' + (uid++),
          name: def.name,
          en: def.en,
          color: def.color,
          cost: def.cost,
          purple: def.purple ? Object.assign({}, def.purple) : null,
          desc: def.desc || ''
        });
      }
    });
    return shuffle(cards, rnd);
  }

  function shuffle(arr, rnd) {
    rnd = rnd || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** 根据人数与配置挑选本局使用的角色牌 */
  function pickCharacterSet(playerCount, setMode) {
    setMode = setMode || 'base';
    let pool;
    if (setMode === 'base') {
      pool = CHARACTERS.filter(c => c.version === 'base');           // 8 张（1-8）
    } else if (setMode === 'dark') {
      // 基本版 + 黑暗城市扩充各号一个 + 皇后
      const want = { 1: 'witch', 2: 'thief', 3: 'magician', 4: 'emperor', 5: 'monk',
                     6: 'alchemist', 7: 'navigator', 8: 'diplomat', 9: 'queen' };
      pool = Object.keys(want).map(k => CHAR_MAP[want[k]]);
    } else {
      // mixed（加强版混合）：从每个编号中随机挑一个，编号 9 只在大局使用
      const byNum = {};
      CHARACTERS.forEach(c => {
        if (c.twoPlayerBan && playerCount <= 2) return;
        if (c.smallBan && playerCount < c.smallBan) return;
        (byNum[c.num] = byNum[c.num] || []).push(c);
      });
      pool = Object.keys(byNum).map(k => {
        const list = byNum[k];
        return list[Math.floor(Math.random() * list.length)];
      }).sort((a, b) => a.num - b.num);
    }
    // 规则限制
    let chars = pool.filter(c => {
      if (c.twoPlayerBan && playerCount <= 2) return false;
      if (c.smallBan && playerCount < c.smallBan) return false;
      return true;
    }).sort((a, b) => a.num - b.num);

    // 2/3 人局固定使用 8 张角色牌
    if (playerCount <= 3 && chars.length > 8) {
      // 保留编号最小的 8 张（且每个编号一张）
      const seen = {};
      chars = chars.filter(c => {
        if (seen[c.num]) return false;
        seen[c.num] = true; return true;
      }).slice(0, 8);
    }

    // 角色牌数必须 ≥ 玩家数 + 1（每轮还要暗置 1 张）
    if (chars.length < playerCount + 1) {
      const usedNums = {};
      chars.forEach(c => { usedNums[c.num] = true; });
      const extra = CHARACTERS.filter(c =>
        !usedNums[c.num] && chars.indexOf(c) < 0 &&
        !(c.twoPlayerBan && playerCount <= 2) &&
        !(c.smallBan && playerCount < c.smallBan)
      ).sort((a, b) => b.num - a.num);
      let i = 0;
      while (chars.length < playerCount + 1 && i < extra.length) {
        if (!usedNums[extra[i].num]) { chars.push(extra[i]); usedNums[extra[i].num] = true; }
        i++;
      }
      chars.sort((a, b) => a.num - b.num);
    }
    return chars;
  }

  return {
    COLORS: COLORS,
    COLOR_ORDER: COLOR_ORDER,
    DISTRICTS: DISTRICTS,
    CHARACTERS: CHARACTERS,
    CHAR_MAP: CHAR_MAP,
    buildDistrictDeck: buildDistrictDeck,
    pickCharacterSet: pickCharacterSet,
    shuffle: shuffle
  };
});
