# 1000 simulations, max depth 2000: hidden-state sampling comparison

Each configuration completed 104 paired seat-games across 16 opening seeds (four seeds for each of 5, 6, 7, and 8 players). For every opening seed, all player seats were tested under all three variants. The learned belief network was disabled, and the policy weights and opponents were fixed.

| Sampler | Firsts / 104 | First rate (pooled) | Mean rank (pooled; lower is better) | Mean rounds | Mean seconds/game |
|---|---:|---:|---:|---:|---:|
| flat4 | 21 / 104 | 20.2% | 3.49 | 11.03 | 38.5 |
| flat32 | 16 / 104 | 15.4% | 4.24 | 11.18 | 20.3 |
| role32 | 17 / 104 | 16.3% | 3.79 | 11.05 | 23.2 |

Pooled numbers weight each played seat equally, so larger tables contribute more games. The next table gives each table size equal weight.

| Sampler | Equal-weight first rate | Equal-weight mean rank |
|---|---:|---:|
| flat4 | 19.7% | 3.44 |
| flat32 | 16.3% | 4.11 |
| role32 | 17.1% | 3.72 |

## By player count

| Players | flat4 first rate / rank | flat32 first rate / rank | role32 first rate / rank |
|---:|---:|---:|---:|
| 5 | 15.0% / 3.00 | 20.0% / 3.35 | 30.0% / 3.10 |
| 6 | 20.8% / 3.67 | 20.8% / 3.67 | 8.3% / 3.92 |
| 7 | 17.9% / 3.04 | 21.4% / 3.82 | 14.3% / 3.39 |
| 8 | 25.0% / 4.06 | 3.1% / 5.59 | 15.6% / 4.47 |

## Paired differences

Differences are left minus right, averaged within opening seed blocks and bootstrapped by cycle within each player count (20,000 resamples). Positive first-rate difference favors the left sampler; negative rank difference favors the left sampler.
- **flat4 vs flat32**: first-rate Δ +3.33 percentage points (95% CI -2.82 to +9.47); mean-rank Δ -0.667 (95% CI -1.040 to -0.292).
- **flat32 vs role32**: first-rate Δ -0.71 percentage points (95% CI -9.89 to +9.90); mean-rank Δ +0.388 (95% CI -0.137 to +0.850).
- **flat4 vs role32**: first-rate Δ +2.61 percentage points (95% CI -6.25 to +11.99); mean-rank Δ -0.278 (95% CI -0.764 to +0.201).

## Interpretation

- With 1000 simulations, flat4 had the best overall mean rank (3.49), followed by role32 (3.79) and flat32 (4.24). Flat4 vs flat32 showed a paired mean-rank advantage for flat4, with a 95% interval that did not include zero; their first-rate interval did include zero, so the champion-rate difference remains uncertain.
- role32 was not reliably better than either flat4 or flat32 on the paired comparisons. Its result varied by table size: strongest at five players, weakest at six.
- The most concerning pattern is flat32 at eight players: 1 first in 32 games (3.1%), compared with 8/32 (25.0%) for flat4. Four seed blocks are too few to establish this as a robust eight-player effect, but it deserves a targeted follow-up.
- This result does not show that deeper search is harmful: this test changed neither depth nor simulations across variants. It shows that, at the same 1000 simulation budget, increasing particles alone did not improve this checkpoint in this opponent setup.

## Settings and limits

- All variants used 1000 MCTS simulations per search and max depth 2000; belief network disabled; CPU execution; same policy weights, hard static NPC opponents, and paired opening/seat schedule.
- The run completed all 312 games (104 per variant) with no failures.
- `role32` constructs 128 proposed worlds and resamples them by role stratum; this evaluates that proposal-based stratifier, not a direct independent role-first posterior sampler. Counts and hashes are in `metadata.json` and `detailed-summary.json`.
- Runtime is total game duration and depends on decisions and game length; it is not a per-search latency measurement.
