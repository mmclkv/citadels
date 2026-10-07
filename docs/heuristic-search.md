# Heuristic difficulty: standalone ISMCTS

Hard NPCs use the same serial ISMCTS core as neural search, with a pure C++
heuristic prior and multiplayer win-focused evaluator. No neural weights or
LibTorch are needed. Both the `npc` and `advance_npcs` game-engine requests use
`choose_native_npc`. Easy/normal NPCs, single legal actions and round confirmations
use the fast heuristic policy. The neural worker's simulation heuristic does not
start another search.

Leaves now combine static evaluation (40%) and bounded heuristic rollouts (60%).
Each rollout copies its determinized world and uses a cheap greedy heuristic,
without the bounded turn planner or nested MCTS. At the action horizon it uses
static win-focused values; terminal rollout outcomes use the heuristic terminal rewards.
The value vector always remains in the original leaf player's seat order even
when other actors move. Rollout work stops when the search deadline is reached.

The hard heuristic search uses 90% first-place utility and 10% normalized rank
utility. Nonterminal first-place chances are estimated with a stable softmax of
public-material strength (temperature 6), so strong rivals matter more than weak
ones. Terminal first place, including tied first place, scores 1; losing positions
score between -1 and -0.8 with a small preference for higher rank. The evaluator,
rollout tails and MCTS terminal backups all use this same objective. The shared
game adapter, neural/CFR training rank rewards and easy/normal policies are unchanged.

Search statistics survive consecutive compatible actions in a game-local session.
After an actual action, the matching action/information-set child becomes the new
root and sibling branches are freed. No authoritative states or old particle pools
are cached: every new decision resamples hidden worlds from current information.
Reuse is conservative: other actors, new rounds/phases/roles, new privately seen
cards, changed hidden-pile counts, missing branches and changed evaluation
settings invalidate the tree.
Creating/replacing/closing a game also releases its session. Exact own-card UIDs,
public counts and legal actions supplement feature hashes so encoding capacity
limits cannot alias distinct reuse roots. Both IPC advancement modes advance the
same session. This intentionally does not reuse across opponents' turns or new
private observations; that would require posterior reweighting.

Unknown cards/roles are sampled into shared-tree particles; heuristic evaluation
uses the current actor's information, not opponents' private cards. Wizard-visible
cards and announced construction pending a Magistrate reaction stay pinned.
Magistrate warrant targets are sorted for non-owners before sampling the real
warrant, so private declaration order cannot affect sampled worlds or search.
Owners retain their actual private commitment; revealed warrants stay pinned.

## Startup environment

| Variable | Default | Meaning |
| --- | ---: | --- |
| `CITADELS_HEURISTIC_MCTS_ENABLED` | `1` | Set `0` to retain the fast hard heuristic. |
| `CITADELS_HEURISTIC_MCTS_SIMULATIONS` | `128` | Maximum total simulations, not per particle. |
| `CITADELS_HEURISTIC_MCTS_PARTICLES` | `8` | Hidden-world samples sharing one tree. |
| `CITADELS_HEURISTIC_MCTS_MAX_DEPTH` | `32` | Maximum actions on a simulation path. |
| `CITADELS_HEURISTIC_MCTS_TIME_MS` | `200` | Ordinary search budget. |
| `CITADELS_HEURISTIC_MCTS_CRITICAL_TIME_MS` | `400` | Draft/near-endgame budget. |
| `CITADELS_HEURISTIC_MCTS_ROLLOUT_STEPS` | `8` | Maximum actions per rollout; `0` disables rollout. |
| `CITADELS_HEURISTIC_MCTS_ROLLOUTS` | `1` | Rollouts per newly evaluated leaf (and a fresh root). |
| `CITADELS_HEURISTIC_MCTS_REUSE_TREE` | `1` | `0` disables retained search trees. |
| `CITADELS_HEURISTIC_MCTS_TREE_NODES` | `4096` | Explicit retained-node budget per game session. |

Time budgets are checked between simulations, include initial root evaluation,
and allow at least one simulation. A single simulation is not forcibly interrupted.
Particle preparation and heuristic fallback are outside that budget. Set both time
budgets to `0` for reproducible fixed-simulation evaluation. No arbitrary upper
clamps are applied to these options; excessive budgets increase CPU/RAM use.
The node budget limits retention, not simulations: an oversized tree is released
after the decision. Each decision performs up to the configured number of NEW
simulations even when older visits are inherited.

The Python event loop dispatches NPC work off-thread. The shared C++ game process
still processes requests sequentially: longer searches can delay other rooms'
engine requests. Neural training with hard opponents will also sample more slowly.

## Diagnostics and validation

`npc` responses include `heuristicSearch` with searched/fallback flags, visits,
expansions, particles, elapsed time and fallback reason. `advance_npcs` reports
aggregate searches/fallbacks/visits/time plus the first fallback reason. Exceptions
or unaligned particles fall back to the existing legal-action heuristic.
`newVisits` counts completed new simulations; `reusedVisits` counts inherited
root visits. `visits` is the total number of visits on root action edges, including
inherited visits, and need not equal their sum (a node's initial leaf evaluation
visits the node without traversing an outgoing edge). `rolloutActions` counts
executed rollout actions; individual responses also include `rollouts` and
`retainedNodes` measured before enforcing the retention budget.

Compile/run `native/heuristic_search_probe.cpp` for prior normalization, vector
values, hidden-information invariance, deterministic particles, legal fallback,
Wizard/Magistrate visibility and time-budget checks. `heuristic_search_games_probe`
runs complete all-hard games (arguments: games, player count, optional fixed
simulation budget). Add `matchup` as the fourth argument to compare one searched
seat against fast hard opponents, rotating that seat and the initial crown.
This smoke comparison is not a statistically conclusive strength benchmark.
Existing batched MCTS and heuristic tactical regressions remain
applicable. Set `CITADELS_TEST_GAME_ENGINE` to a compiled game-engine executable to
run `python_backend/test_native_heuristic_search.py` IPC checks.
