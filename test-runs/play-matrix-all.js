/* 全矩阵状态机压力测试：人数 2~8 × 角色组 base/dark/mixed × 多种子，
 * 复用 play-100-mixed-6.js 的驱动与不变量校验（卡牌/角色守恒、金币非负、计分自洽、不终止/崩溃）。
 *
 * 用法：node test-runs/play-matrix-all.js
 * 环境变量：PER_COMBO 每组合局数（默认 20）。
 */
'use strict';
const fs = require('fs');
const { playOne } = require('./play-100-mixed-6.js');

const PLAYER_COUNTS = [2, 3, 4, 5, 6, 7, 8];
const CHAR_SETS = ['base', 'dark', 'mixed'];
const PER_COMBO = parseInt(process.env.PER_COMBO || '20', 10);
const END_DISTRICTS = 8;

function main() {
  const rows = [];
  const allBad = [];
  const t0 = Date.now();
  let totalGames = 0;

  for (const players of PLAYER_COUNTS) {
    for (const charSet of CHAR_SETS) {
      let good = 0, bad = 0;
      const kinds = {};
      for (let k = 0; k < PER_COMBO; k++) {
        const seed = (Math.floor(Math.random() * 0x7fffffff)) >>> 0;
        let r;
        try { r = playOne(seed, { players, charSet, endDistricts: END_DISTRICTS }); }
        catch (e) { r = { ok: false, reason: 'crash', seed, error: String(e && e.stack || e), problems: [], scoreProblems: [] }; }
        totalGames++;
        const pb = (r.problems ? r.problems.length : 0) + (r.scoreProblems ? r.scoreProblems.length : 0);
        if (r.ok && pb === 0) good++;
        else {
          bad++;
          allBad.push({ players, charSet, seed, levels: r.levels, reason: r.reason, problems: r.problems, scoreProblems: r.scoreProblems, error: r.error });
          console.log(`  !! ${players}人 ${charSet} seed=${seed} levels=${(r.levels || []).join(',')} ` +
            JSON.stringify((r.problems || []).slice(0, 2)));
        }
        for (const p of (r.problems || [])) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
        for (const p of (r.scoreProblems || [])) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
      }
      rows.push({ players, charSet, games: PER_COMBO, clean: good, bad, kinds });
      const tag = bad === 0 ? 'OK  ' : 'BAD ';
      console.log(`[${tag}] ${players}人 ${charSet.padEnd(5)} → 干净 ${good}/${PER_COMBO}` +
        (bad ? '  问题分类=' + JSON.stringify(kinds) : ''));
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const totalClean = rows.reduce((s, r) => s + r.clean, 0);
  const summary = {
    playerCounts: PLAYER_COUNTS, charSets: CHAR_SETS, perCombo: PER_COMBO,
    totalGames, totalClean, totalBad: totalGames - totalClean, elapsedSec: dt, rows
  };
  console.log('\n================ 矩阵汇总 ================');
  console.log(JSON.stringify(summary, null, 2));

  if (allBad.length) {
    console.log('\n--- 问题明细（最多 20 条）---');
    allBad.slice(0, 20).forEach(b => {
      console.log(`  ${b.players}人 ${b.charSet} seed=${b.seed} reason=${b.reason || ''} ` +
        JSON.stringify((b.problems || []).slice(0, 2)) + ' ' + JSON.stringify((b.scoreProblems || []).slice(0, 2)));
      if (b.error) console.log('    ' + String(b.error).split('\n')[0]);
    });
  }

  const reportPath = __dirname + '/play-matrix-all.report.json';
  fs.writeFileSync(reportPath, JSON.stringify({ summary, bad: allBad }, null, 2));
  console.log('\n报告已写入: ' + reportPath);
  const problemCount = totalGames - totalClean;
  console.log(problemCount === 0 ? `\n结论：全矩阵 ${totalGames} 局全部干净完成。` : `\n结论：全矩阵发现 ${problemCount} 局存在问题。`);
  return problemCount;
}

if (require.main === module) {
  process.exit(main() === 0 ? 0 : 1);
}
module.exports = { main };
