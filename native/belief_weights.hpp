#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

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

}  // namespace citadels::native
