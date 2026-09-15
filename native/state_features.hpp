#pragma once

#include <algorithm>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

// 固定长度、无指针的输入特征：网络可以在不同人数和不同牌堆状态下复用同一模型。
// 每位玩家 8 个槽位：[gold, hand, city, roleHash, active, crown, builds, roundSeen]，
// 前 4 个全局槽位：[playerCount, activePlayer, deckCount, round]。
inline std::vector<float> encode_features(const NativeGameState& state,
                                          int perspective_player = -1,
                                          int max_players = 8) {
  const int slots = std::max(1, max_players);
  std::vector<float> features(static_cast<size_t>(4 + slots * 8), 0.0f);
  features[0] = static_cast<float>(state.players.size()) / slots;
  int active_relative = state.active_player;
  if (perspective_player >= 0 && state.active_player >= 0 && !state.players.empty())
    active_relative = (state.active_player - perspective_player + static_cast<int>(state.players.size())) %
                      static_cast<int>(state.players.size());
  features[1] = active_relative < 0 ? 0.0f : static_cast<float>(active_relative) / slots;
  features[2] = static_cast<float>(state.deck.deck_count()) / 100.0f;
  features[3] = static_cast<float>(state.round) / 100.0f;
  for (int i = 0; i < slots && i < static_cast<int>(state.players.size()); ++i) {
    const int absolute = perspective_player >= 0 && !state.players.empty()
        ? (perspective_player + i) % static_cast<int>(state.players.size()) : i;
    if (absolute >= static_cast<int>(state.players.size())) continue;
    const auto& p = state.players[absolute];
    const size_t base = static_cast<size_t>(4 + i * 8);
    features[base] = static_cast<float>(p.gold) / 20.0f;
    features[base + 1] = static_cast<float>(p.hand.size()) / 20.0f;
    features[base + 2] = static_cast<float>(p.city.size()) / state.end_districts;
    features[base + 3] = static_cast<float>(std::hash<std::string>{}(p.role_id) % 997) / 997.0f;
    features[base + 4] = i == active_relative ? 1.0f : 0.0f;
    features[base + 5] = p.has_crown ? 1.0f : 0.0f;
    features[base + 6] = i == active_relative ? static_cast<float>(state.builds) / 4.0f : 0.0f;
    features[base + 7] = state.resources_taken ? 1.0f : 0.0f;
  }
  return features;
}

}  // namespace citadels::native
