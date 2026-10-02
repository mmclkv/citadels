#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#include "game_adapter.hpp"
#include "determinize.hpp"
#include "neural_evaluator.hpp"
#include "npc_policy.hpp"

namespace citadels::native {

struct NativeTrainingRow {
  int player = -1;
  std::vector<float> state;
  std::vector<std::vector<float>> actions;
  std::vector<float> policy;
  std::array<float, kValueSlots> reward{};
  std::array<float, kValueSlots> value_mask{};
};

struct NativeScoreRow {
  int player = -1;
  int base = 0;
  int bonus = 0;
  int total = 0;
};

inline std::vector<float> native_belief_weights(
    const std::vector<NativeGameState>& particles, int viewer, bool enabled,
    float decay = 0.15f) {
  std::vector<float> weights(particles.size(), 1.0f);
  if (!enabled || particles.empty() || decay >= 1.0f) return weights;
  const auto& reference = particles.front();
  for (size_t player = 0; player < reference.observations.size(); ++player) {
    if (static_cast<int>(player) == viewer) continue;
    const auto& observation = reference.observations[player];
    if (!observation.valid || observation.gold < 1) continue;
    for (size_t sample = 0; sample < particles.size(); ++sample) {
      if (player >= particles[sample].players.size()) continue;
      const auto& hand = particles[sample].players[player].hand;
      if (hand.empty()) continue;
      std::vector<int> costs;
      for (const auto& card : hand) {
        if (std::find(observation.free_colors.begin(), observation.free_colors.end(), card.color) !=
            observation.free_colors.end()) continue;
        costs.push_back(card.cost);
      }
      std::sort(costs.begin(), costs.end());
      const size_t drawn = std::min(costs.size(), hand.size() > static_cast<size_t>(std::max(0, observation.hand_size))
        ? hand.size() - static_cast<size_t>(std::max(0, observation.hand_size)) : 0);
      int violations = 0;
      for (size_t i = drawn; i < costs.size(); ++i)
        if (costs[i] <= observation.gold) ++violations;
      weights[sample] *= std::pow(decay, static_cast<float>(violations));
      weights[sample] = std::max(weights[sample], 1e-6f);
    }
  }
  return weights;
}

struct NativeSelfPlayResult {
  std::vector<NativeTrainingRow> rows;
  std::vector<NativeScoreRow> scores;
  std::vector<int> winners;
  int steps = 0;
  int rounds = 0;
  double search_ms = 0.0;
  double network_reward = 0.0;
  double network_win = 0.0;
  double network_score = 0.0;
};

inline std::vector<NativeScoreRow> native_score_rows(const NativeGameState& state) {
  static constexpr std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
  std::vector<NativeScoreRow> result;
  result.reserve(state.players.size());
  for (size_t i = 0; i < state.players.size(); ++i) {
    const auto& player = state.players[i];
    NativeScoreRow score;
    score.player = static_cast<int>(i);
    std::array<bool, 5> have{};
    int museum = 0, beautified = 0, usable_ghosts = 0;
    for (const auto& district : player.city) {
      score.base += district.card.score_as > 0 ? district.card.score_as
        : district.card.score_value > 0 ? district.card.score_value : district.card.cost;
      for (size_t color = 0; color < colors.size(); ++color)
        if (district.card.color == colors[color]) have[color] = true;
      museum += static_cast<int>(district.museum_cards.size());
      beautified += district.beautified ? 1 : 0;
      if (district.effect == "anyColorScore" && district.built_round != state.round) ++usable_ghosts;
    }
    int missing = 0;
    for (bool present : have) if (!present) ++missing;
    score.bonus = museum + beautified;
    if (missing == 0 || (missing > 0 && missing <= usable_ghosts)) score.bonus += 3;
    if (state.first_to_finish == static_cast<int>(i)) score.bonus += 4;
    else if (player.city.size() >= static_cast<size_t>(state.end_districts)) score.bonus += 2;
    score.total = score.base + score.bonus;
    result.push_back(score);
  }
  return result;
}

template <class Search>
NativeSelfPlayResult run_native_selfplay(
    NativeGameState& state, const NativeGameAdapter& game, Search&& search,
    const std::unordered_set<std::string>& network_players, int max_rounds,
    int max_steps, int action_encoding_version, bool include_own_hand,
    bool include_city_identity, bool include_public_context, int particle_count,
    uint32_t determinization_seed, bool belief_enabled) {
  NativeSelfPlayResult output;
  while (!game.terminal(state) && state.round <= max_rounds && output.steps < max_steps) {
    const int actor = game.next_player(state);
    if (actor < 0 || actor >= static_cast<int>(state.players.size()))
      throw std::runtime_error("C++ 自对弈无有效行动者（phase=" +
                               std::to_string(static_cast<int>(state.phase)) + ")");
    auto actions = game.legal_actions(state, actor);
    if (actions.empty()) throw std::runtime_error("C++ 自对弈当前局面没有合法动作");

    std::vector<float> policy(actions.size(), 1.0f / static_cast<float>(actions.size()));
    const std::string& player_id = state.players[actor].id;
    const bool is_network = network_players.count(player_id) != 0;
    if (is_network && actions.size() > 1) {
      std::vector<NativeGameState> root_states;
      const int samples = std::max(1, std::min(8, particle_count));
      root_states.reserve(static_cast<size_t>(samples));
      for (int sample = 0; sample < samples; ++sample) {
        const uint32_t seed = determinization_seed ^
          (static_cast<uint32_t>(output.steps + 1) * 0x9E3779B1u) ^
          (static_cast<uint32_t>(actor + 1) * 0x85EBCA6Bu) ^
          (static_cast<uint32_t>(sample + 1) * 0xC2B2AE35u);
        root_states.push_back(determinize_native_state(state, actor, seed));
      }
      std::vector<float> root_weights = native_belief_weights(root_states, actor, belief_enabled);
      const auto started = std::chrono::steady_clock::now();
      const auto searched = search(root_states, actor, root_weights);
      output.search_ms += std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - started).count();
      if (searched.policy.size() != actions.size())
        throw std::runtime_error("C++ 自对弈搜索策略与合法动作数量不一致");
      policy = searched.policy;
    }

    if (actions.size() > 1 && is_network) {
      NativeTrainingRow row;
      row.player = actor;
      row.state = encode_network_state(state, actor, include_own_hand,
                                       include_city_identity, include_public_context);
      row.actions.reserve(actions.size());
      for (const auto& action : actions)
        row.actions.push_back(encode_network_action(action, &state, actor, action_encoding_version));
      row.policy = policy;
      output.rows.push_back(std::move(row));
    }

    size_t selected = actions.size() - 1;
    if (is_network) {
      double roll = state.rng.next();
      double cumulative = 0.0;
      for (size_t i = 0; i < policy.size(); ++i) {
        cumulative += std::max(0.0f, policy[i]);
        if (roll < cumulative) { selected = i; break; }
      }
    } else {
      const uint32_t npc_seed = determinization_seed ^
        (static_cast<uint32_t>(output.steps + 1) * 0x9E3779B1u) ^
        (static_cast<uint32_t>(actor + 1) * 0x85EBCA6Bu);
      const int npc_action = NativeNpcPolicy::choose(state, actor, actions, npc_seed);
      if (npc_action < 0 || npc_action >= static_cast<int>(actions.size()))
        throw std::runtime_error("C++ NPC 没有选出合法动作");
      selected = static_cast<size_t>(npc_action);
    }
    if (!game.apply(state, actor, actions[selected]))
      throw std::runtime_error("C++ 自对弈采样出的合法动作无法应用");
    ++output.steps;
  }

  output.rounds = state.round;
  output.scores = native_score_rows(state);
  float best = -std::numeric_limits<float>::infinity();
  for (const auto& score : output.scores) best = std::max(best, static_cast<float>(score.total));
  for (const auto& score : output.scores) if (score.total == best) output.winners.push_back(score.player);

  for (auto& row : output.rows) {
    const auto values = native_terminal_reward_vector(state, row.player);
    row.reward = values;
    for (size_t relative = 0; relative < state.players.size() && relative < kValueSlots; ++relative)
      row.value_mask[relative] = 1.0f;
  }
  if (!network_players.empty()) {
    double rewards = 0.0, scores = 0.0, wins = 0.0;
    int count = 0;
    for (size_t i = 0; i < state.players.size(); ++i) {
      if (!network_players.count(state.players[i].id)) continue;
      rewards += native_terminal_reward(state, static_cast<int>(i));
      scores += output.scores[i].total;
      wins += std::find(output.winners.begin(), output.winners.end(), static_cast<int>(i)) != output.winners.end();
      ++count;
    }
    if (count > 0) {
      output.network_reward = rewards / count;
      output.network_score = scores / count;
      output.network_win = wins / count;
    }
  }
  return output;
}

}  // namespace citadels::native
