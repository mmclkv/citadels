#pragma once

#include <algorithm>
#include <random>
#include <string>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

// Re-sample the hidden zones from the root player's information set. The
// authoritative game state is never modified. Publicly played roles, the
// viewer's hand/roles, and a pending card currently controlled by the viewer
// remain pinned; unknown district cards and unplayed opponent roles are
// redistributed without changing pile sizes.
inline NativeGameState determinize_native_state(const NativeGameState& source,
                                                int viewer,
                                                uint32_t seed) {
  NativeGameState result = source;
  if (viewer < 0 || viewer >= static_cast<int>(result.players.size())) return result;
  std::mt19937 rng(seed);
  // Random streams are hidden state too (they govern future deck recycling and
  // character shuffles); never carry the authoritative seed into search worlds.
  result.rng = JsRng(seed ^ 0xA511E9B3u);

  std::vector<DistrictCard*> hidden_cards;
  for (size_t player = 0; player < result.players.size(); ++player) {
    if (static_cast<int>(player) == viewer) continue;
    for (auto& card : result.players[player].hand) hidden_cards.push_back(&card);
    for (auto& district : result.players[player].city)
      for (auto& card : district.museum_cards) hidden_cards.push_back(&card);
  }
  for (auto& card : result.deck.deck_cards()) hidden_cards.push_back(&card);
  for (auto& card : result.deck.discard_cards()) hidden_cards.push_back(&card);
  if (result.active_player != viewer)
    for (auto& card : result.pending_cards) hidden_cards.push_back(&card);

  std::vector<DistrictCard> shuffled_cards;
  shuffled_cards.reserve(hidden_cards.size());
  for (const auto* card : hidden_cards) shuffled_cards.push_back(*card);
  std::shuffle(shuffled_cards.begin(), shuffled_cards.end(), rng);
  for (size_t i = 0; i < hidden_cards.size(); ++i) *hidden_cards[i] = std::move(shuffled_cards[i]);

  std::vector<std::string*> hidden_roles;
  std::vector<std::string> publicly_called_roles;
  if (result.phase == NativePhase::Action && !result.call_queue.empty()) {
    const int last_public = std::min(result.call_index, static_cast<int>(result.call_queue.size()) - 1);
    for (int i = 0; i <= last_public; ++i)
      publicly_called_roles.push_back(result.call_queue[static_cast<size_t>(i)].char_id);
  }
  for (size_t player = 0; player < result.players.size(); ++player) {
    if (static_cast<int>(player) == viewer) continue;
    auto& roles = result.players[player].role_ids;
    const auto& played = result.players[player].played;
    for (auto& role : roles)
      if (std::find(played.begin(), played.end(), role) == played.end() &&
          std::find(publicly_called_roles.begin(), publicly_called_roles.end(), role) == publicly_called_roles.end())
        hidden_roles.push_back(&role);
  }
  if (result.phase == NativePhase::Draft && result.draft_current_player != viewer)
    for (auto& role : result.draft_pool) hidden_roles.push_back(&role);
  const bool viewer_picking_blind = result.phase == NativePhase::Draft &&
      result.draft_current_player == viewer && result.draft_sub == "pick" &&
      result.draft_step >= 0 && result.draft_step < static_cast<int>(result.draft_steps.size()) &&
      result.draft_steps[result.draft_step].from_face_down;
  if (!viewer_picking_blind)
    for (auto& role : result.draft_face_down) hidden_roles.push_back(&role);
  std::vector<std::string> shuffled_roles;
  shuffled_roles.reserve(hidden_roles.size());
  for (const auto* role : hidden_roles) shuffled_roles.push_back(*role);
  std::shuffle(shuffled_roles.begin(), shuffled_roles.end(), rng);
  for (size_t i = 0; i < hidden_roles.size(); ++i) *hidden_roles[i] = std::move(shuffled_roles[i]);

  // Private signed-role guesses are unknown to other players. Keep public
  // target sets intact and sample only the concealed commitment.
  if (result.magistrate_player != viewer && !result.magistrate_claimed &&
      !result.magistrate_nums.empty())
    result.magistrate_signed = result.magistrate_nums[rng() % result.magistrate_nums.size()];
  if (result.blackmailer_player != viewer && result.blackmailer_signed >= 0 &&
      !result.blackmailer_nums.empty()) {
    std::vector<int> candidates;
    for (int number : result.blackmailer_nums)
      if (std::find(result.blackmailer_done.begin(), result.blackmailer_done.end(), number) ==
          result.blackmailer_done.end()) candidates.push_back(number);
    if (!candidates.empty()) result.blackmailer_signed = candidates[rng() % candidates.size()];
  }

  // Draft choices already made by opponents are hidden; reconstruct the
  // uncalled queue from the sampled roles so it cannot reveal the true deal.
  if (result.phase == NativePhase::Action && !result.call_queue.empty()) {
    const int preserve = std::min(result.call_index, static_cast<int>(result.call_queue.size()) - 1);
    std::vector<NativeCallEntry> queue(result.call_queue.begin(), result.call_queue.begin() + preserve + 1);
    for (size_t player = 0; player < result.players.size(); ++player) {
      const auto& p = result.players[player];
      for (const auto& role : p.role_ids) {
        if (std::find(p.played.begin(), p.played.end(), role) != p.played.end()) continue;
        if (std::any_of(queue.begin(), queue.end(), [&](const NativeCallEntry& entry) { return entry.char_id == role; })) continue;
        queue.push_back({role, role_number(role), static_cast<int>(player)});
      }
    }
    std::stable_sort(queue.begin() + preserve + 1, queue.end(),
      [](const NativeCallEntry& a, const NativeCallEntry& b) { return a.number < b.number; });
    result.call_queue = std::move(queue);
  }
  return result;
}

}  // namespace citadels::native
