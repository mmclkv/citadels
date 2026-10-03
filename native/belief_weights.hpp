#pragma once

#include <algorithm>
#include <cmath>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

inline std::vector<float> native_belief_weights(
    const std::vector<NativeGameState>& particles, int viewer, bool enabled,
    float decay = 0.5f) {
  std::vector<float> weights(particles.size(), 1.0f);
  if (!enabled || particles.empty() || decay >= 1.0f) return weights;
  const auto& reference = particles.front();
  for (size_t player = 0; player < reference.observations.size(); ++player) {
    if (static_cast<int>(player) == viewer) continue;
    const auto& observation = reference.observations[player];
    // These observations describe the instant a player ended a turn. As soon
    // as any later turn completes, theft, draws, spending, and other effects
    // may have changed their hidden hand/resources. Only apply evidence to the
    // exact same turn and round; snapshots without the newer stamp are ignored.
    if (!observation.valid || observation.round != reference.round ||
        observation.turns_completed <= 0 ||
        observation.turns_completed != reference.turns_completed) continue;
    for (size_t sample = 0; sample < particles.size(); ++sample) {
      if (player >= particles[sample].players.size()) continue;
      const auto& hand = particles[sample].players[player].hand;
      if (hand.empty()) continue;
      std::vector<int> costs;
      for (const auto& card : hand) {
        int same_name_count = 0;
        for (const auto& name : observation.built_names)
          if (name == card.name) ++same_name_count;
        const bool free_color = !observation.witch_resume &&
            std::find(observation.free_colors.begin(), observation.free_colors.end(), card.color) !=
                                observation.free_colors.end();
        const BuildCard build_card{card.name, card.color, free_color ? 0 : card.cost};
        const BuildContext build_context{observation.role_id, observation.witch_resume,
            observation.gold, observation.builds, observation.build_limit,
            same_name_count, observation.quarry_count};
        if (!can_build(build_card, build_context)) continue;
        costs.push_back(build_card.cost);
      }
      std::sort(costs.begin(), costs.end());
      const size_t drawn = std::min(costs.size(), hand.size() > static_cast<size_t>(std::max(0, observation.hand_size))
        ? hand.size() - static_cast<size_t>(std::max(0, observation.hand_size)) : 0);
      int violations = 0;
      for (size_t i = drawn; i < costs.size(); ++i)
        if (costs[i] <= observation.gold) ++violations;
      // "Could have built" is weak strategic evidence, not proof. Apply at
      // most one likelihood penalty per observation instead of compounding it
      // once for every affordable card in a hand.
      if (violations > 0) weights[sample] *= decay;
      weights[sample] = std::max(weights[sample], 1e-6f);
    }
  }
  return weights;
}

}  // namespace citadels::native
