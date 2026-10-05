# Heuristic difficulty: standalone ISMCTS

Hard NPCs use the same serial ISMCTS core as neural search, with a pure C++
heuristic prior and multiplayer expected-rank evaluator. No neural weights or
LibTorch are needed. Both the `npc` and `advance_npcs` game-engine requests use
`choose_native_npc`. Easy/normal NPCs, single legal actions and round confirmations
use the fast heuristic policy. The neural worker's simulation heuristic does not
start another search.

This is phase 1: static leaf evaluation, without rollouts or persistent tree reuse.
Unknown cards/roles are sampled into shared-tree particles; heuristic evaluation
uses the current actor's information, not opponents' private cards. Wizard-visible
cards and announced construction pending a Magistrate reaction stay pinned.

## Startup environment

| Variable | Default | Meaning |
| --- | ---: | --- |
| `CITADELS_HEURISTIC_MCTS_ENABLED` | `1` | Set `0` to retain the fast hard heuristic. |
| `CITADELS_HEURISTIC_MCTS_SIMULATIONS` | `128` | Maximum total simulations, not per particle. |
| `CITADELS_HEURISTIC_MCTS_PARTICLES` | `8` | Hidden-world samples sharing one tree. |
| `CITADELS_HEURISTIC_MCTS_MAX_DEPTH` | `32` | Maximum actions on a simulation path. |
| `CITADELS_HEURISTIC_MCTS_TIME_MS` | `200` | Ordinary search budget. |
| `CITADELS_HEURISTIC_MCTS_CRITICAL_TIME_MS` | `400` | Draft/near-endgame budget. |

Time budgets are checked between simulations, include initial root evaluation,
and allow at least one simulation. A single simulation is not forcibly interrupted.
Particle preparation and heuristic fallback are outside that budget. Set both time
budgets to `0` for reproducible fixed-simulation evaluation. No arbitrary upper
clamps are applied to these options; excessive budgets increase CPU/RAM use.

The Python event loop dispatches NPC work off-thread. The shared C++ game process
still processes requests sequentially: longer searches can delay other rooms'
engine requests. Neural training with hard opponents will also sample more slowly.

## Diagnostics and validation

`npc` responses include `heuristicSearch` with searched/fallback flags, visits,
expansions, particles, elapsed time and fallback reason. `advance_npcs` reports
aggregate searches/fallbacks/visits/time plus the first fallback reason. Exceptions
or unaligned particles fall back to the existing legal-action heuristic.

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
