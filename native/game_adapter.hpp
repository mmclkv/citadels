#pragma once

#include <algorithm>
#include <array>
#include <string>
#include <vector>

#include "game_state.hpp"
#include "magician_machine.hpp"
#include "mcts_core.hpp"

namespace citadels::native {

// Keep terminal rewards equivalent to training/train.js: scoreValue/cost
// building points, museum and beautification points, five-color bonus (with
// last-round ghost-town exclusion), and completion bonuses.
inline std::array<float, kValueSlots> native_terminal_reward_vector(
    const NativeGameState& state, int perspective_player) {
  std::array<float, kValueSlots> result{};
  if (perspective_player < 0 || perspective_player >= static_cast<int>(state.players.size())) return result;
  struct Score { int player = -1; float total = 0.0f; };
  std::vector<Score> scores;
  scores.reserve(state.players.size());
  constexpr std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
  for (size_t i = 0; i < state.players.size(); ++i) {
    const auto& player = state.players[i];
    float base = 0.0f;
    int museum = 0, beautified = 0, usable_ghosts = 0;
    std::array<bool, 5> have{};
    for (const auto& district : player.city) {
      base += district.card.score_value > 0 ? district.card.score_value : district.card.cost;
      for (size_t color = 0; color < colors.size(); ++color)
        if (district.card.color == colors[color]) have[color] = true;
      museum += static_cast<int>(district.museum_cards.size());
      if (district.beautified) ++beautified;
      if (district.effect == "anyColorScore" && district.built_round != state.round)
        ++usable_ghosts;
    }
    int missing = 0;
    for (bool present : have) if (!present) ++missing;
    int bonus = museum + beautified;
    if (missing == 0 || missing <= usable_ghosts) bonus += 3;
    if (state.first_to_finish == static_cast<int>(i)) bonus += 4;
    else if (player.city.size() >= static_cast<size_t>(state.end_districts)) bonus += 2;
    scores.push_back({static_cast<int>(i), base + bonus});
  }
  for (size_t rel = 0; rel < scores.size() && rel < kValueSlots; ++rel) {
    const int player = (perspective_player + static_cast<int>(rel)) % static_cast<int>(state.players.size());
    const float total = scores[static_cast<size_t>(player)].total;
    // Competition ranking: equal totals share a rank; the next rank skips
    // the tied places. This matches training/train.js exactly.
    size_t rank = 0;
    for (const auto& other : scores) if (other.total > total) ++rank;
    result[rel] = scores.size() == 1
      ? 1.0f : 1.0f - 2.0f * static_cast<float>(rank) / static_cast<float>(scores.size() - 1);
  }
  return result;
}

inline float native_terminal_reward(const NativeGameState& state, int player_index) {
  return native_terminal_reward_vector(state, player_index)[0];
}

struct NativeSearchAction {
  ActionType type = ActionType::EndTurn;
  std::string uid;
  std::string name;
  std::string effect;
  std::string target;
  std::vector<std::string> selected_uids;
  std::string secondary_uid;
};

// 将统一原生状态接入通用 PUCT。这里的动作集合只暴露当前状态真正可执行的
// 基础资源、建造、紫色建筑能力和回合结束动作；更复杂的多步 pending 动作
// 继续沿用同一接口扩展，不在搜索核心里硬编码规则。
class NativeGameAdapter final : public GameAdapter<NativeGameState, NativeSearchAction> {
 public:
  static int char_number(const std::string& id) {
    if (id == "assassin" || id == "witch") return 1;
    if (id == "thief") return 2;
    if (id == "magician" || id == "prophet") return 3;
    if (id == "king" || id == "emperor" || id == "noble") return 4;
    if (id == "bishop" || id == "monk") return 5;
    if (id == "merchant" || id == "alchemist" || id == "businessman") return 6;
    if (id == "architect" || id == "navigator" || id == "scholar") return 7;
    if (id == "warlord" || id == "diplomat" || id == "marshal") return 8;
    if (id == "queen" || id == "artist") return 9;
    return -1;
  }

  static bool face_up_removed(const NativeGameState& state, int number) {
    return std::any_of(state.draft_face_up.begin(), state.draft_face_up.end(),
      [&](const std::string& id) { return char_number(id) == number; });
  }

  static bool can_build(const NativeGameState& state, const NativePlayer& player,
                        const DistrictCard& card) {
    int same = 0, quarry = 0;
    for (const auto& district : player.city) {
      if (district.name == card.name) ++same;
      if (district.effect == "quarry") ++quarry;
    }
    int build_limit = 1;
    if (player.role_id == "architect") build_limit = 3;
    else if (player.role_id == "prophet" || player.role_id == "scholar") build_limit = 2;
    else if (player.role_id == "navigator") build_limit = state.turn_phase == "witch_resume" ? 1 : 0;
    BuildCard build_card{card.name, card.color, card.cost};
    BuildContext context{player.role_id, state.turn_phase == "witch_resume",
                         player.gold, state.builds, build_limit, same, quarry};
    return !card.name.empty() && citadels::native::can_build(build_card, context);
  }

  static std::vector<std::vector<std::string>> redraw_candidates(const NativePlayer& player) {
    std::vector<std::vector<std::string>> result;
    result.push_back({});
    if (!player.hand.empty()) {
      std::vector<std::string> all;
      for (const auto& card : player.hand) all.push_back(card.uid);
      result.push_back(std::move(all));
    }
    std::vector<const DistrictCard*> by_cost;
    by_cost.reserve(player.hand.size());
    for (const auto& card : player.hand) by_cost.push_back(&card);
    std::stable_sort(by_cost.begin(), by_cost.end(), [](const auto* left, const auto* right) {
      if (left->cost != right->cost) return left->cost < right->cost;
      return left->uid < right->uid;
    });
    const size_t limit = std::min<size_t>(4, by_cost.size());
    for (size_t count = 1; count <= limit; ++count) {
      std::vector<std::string> low, high;
      for (size_t i = 0; i < count; ++i) {
        low.push_back(by_cost[i]->uid);
        high.push_back(by_cost[by_cost.size() - count + i]->uid);
      }
      result.push_back(std::move(low));
      result.push_back(std::move(high));
    }
    return result;
  }

  std::vector<NativeSearchAction> legal_actions(const NativeGameState& state,
                                                int player) const override {
    if (state.phase == NativePhase::RoundConfirm) {
      if (player < 0 || player >= static_cast<int>(state.players.size()) ||
          (state.round_confirmed.size() == state.players.size() && state.round_confirmed[player])) return {};
      return {{ActionType::ConfirmRound}};
    }
    if (state.reaction_kind == "graveyard") {
      if (player != state.reaction_player) return {};
      return {{ActionType::Reaction, {}, "use", {}}, {ActionType::Reaction, {}, "skip", {}}};
    }
    if (state.pending_kind == "magician_choice") {
      if (player != state.active_player) return {};
      return {{ActionType::MagicianMode, {}, "swap", {}},
              {ActionType::MagicianMode, {}, "redraw", {}}};
    }
    if (state.pending_kind == "magician_swap") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (size_t i = 0; i < state.players.size(); ++i)
        if (static_cast<int>(i) != player) actions.push_back({ActionType::ChoosePlayer, {}, {}, {}, state.players[i].id});
      return actions;
    }
    if (state.pending_kind == "magician_redraw") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& uids : redraw_candidates(state.players[player])) {
        const bool duplicate = std::any_of(actions.begin(), actions.end(), [&](const auto& action) {
          return action.selected_uids == uids;
        });
        if (!duplicate) actions.push_back({ActionType::ChooseCards, {}, {}, {}, {}, uids});
      }
      return actions;
    }
    if (state.pending_kind == "emperor_crown") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (size_t i = 0; i < state.players.size(); ++i)
        if (static_cast<int>(i) != player) actions.push_back({ActionType::EmperorCrown, {}, {}, {}, state.players[i].id});
      return actions;
    }
    if (state.pending_kind == "emperor_take") {
      if (player != state.active_player) return {};
      return {{ActionType::EmperorTake, {}, "gold", {}}, {ActionType::EmperorTake, {}, "card", {}}};
    }
    if (state.pending_kind == "diplomat_mine") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& district : state.players[player].city)
        if (!district.fortress) actions.push_back({ActionType::ChooseDistrict, district.card.uid, {}, {}, state.players[player].id});
      if (actions.empty()) actions.push_back({ActionType::AbilitySkip});
      return actions;
    }
    if (state.pending_kind == "navigator_bonus") {
      if (player != state.active_player) return {};
      return {{ActionType::NavigatorBonus, {}, "gold", {}}, {ActionType::NavigatorBonus, {}, "cards", {}}};
    }
    if (state.pending_kind == "monk_declare") {
      if (player != state.active_player) return {};
      const int blue = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
        [](const NativeDistrict& d) { return d.card.color == "blue"; }));
      std::vector<NativeSearchAction> actions;
      for (int gold = 0; gold <= blue; ++gold) actions.push_back({ActionType::MonkResource, {}, std::to_string(gold), std::to_string(blue - gold)});
      return actions;
    }
    if (state.pending_kind == "scholar_pick" || state.pending_kind == "draw_keep") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& card : state.pending_cards) actions.push_back({
        state.pending_kind == "scholar_pick" ? ActionType::ScholarPick : ActionType::DrawKeep,
        card.uid, {}, {}, {}});
      return actions;
    }
    if (state.pending_kind == "prophet_give") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& card : state.players[player].hand)
        actions.push_back({ActionType::ProphetGive, card.uid});
      return actions;
    }
    if (state.pending_kind == "artist") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      const bool full = state.pending_selected.size() >= 2;
      const bool broke = state.players[player].gold <= static_cast<int>(state.pending_selected.size());
      if (!full && !broke) {
        for (const auto& district : state.players[player].city)
          if (!district.beautified && std::find(state.pending_selected.begin(), state.pending_selected.end(), district.card.uid) == state.pending_selected.end())
            actions.push_back({ActionType::ChooseDistrict, district.card.uid, {}, {}, state.players[player].id});
      }
      actions.push_back({ActionType::ArtistDone, {}, {}, {}, {}, state.pending_selected});
      return actions;
    }
    if (state.pending_kind == "diplomat_theirs") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      const auto mine_it = std::find_if(state.players[player].city.begin(), state.players[player].city.end(),
        [&](const NativeDistrict& district) { return district.card.uid == state.pending_uid; });
      if (mine_it != state.players[player].city.end()) {
        const int quarry = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
          [](const NativeDistrict& own) { return own.effect == "quarry"; }));
        for (size_t i = 0; i < state.players.size(); ++i) if (static_cast<int>(i) != player)
          for (const auto& district : state.players[i].city) {
            if (district.fortress) continue;
            const int same_name = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
              [&](const NativeDistrict& own) { return own.name == district.name; }));
            if (same_name >= 1 + quarry) continue;
            if (std::max(0, district.card.cost - mine_it->card.cost) > state.players[player].gold) continue;
            actions.push_back({ActionType::ChooseDistrict, district.card.uid, {}, {}, state.players[i].id});
          }
      }
      if (actions.empty()) actions.push_back({ActionType::AbilitySkip});
      return actions;
    }
    if (state.pending_kind == "warlord_destroy" || state.pending_kind == "marshal_seize") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (size_t i = 0; i < state.players.size(); ++i) {
        if (state.pending_kind == "marshal_seize" && static_cast<int>(i) == player) continue;
        if (state.players[i].city.size() >= static_cast<size_t>(state.end_districts)) continue;
        if (static_cast<int>(i) != player && state.pending_kind == "warlord_destroy" && state.players[i].role_id == "bishop") continue;
        for (const auto& district : state.players[i].city) {
          if (district.fortress || (state.pending_kind == "marshal_seize" && district.card.cost > 3)) continue;
          if (state.pending_kind == "warlord_destroy") {
            const bool other_wall = std::any_of(state.players[i].city.begin(), state.players[i].city.end(),
              [&](const NativeDistrict& other) {
                return other.card.uid != district.card.uid && other.effect == "wallCost";
              });
            MilitaryCard military{district.name, district.card.cost, district.fortress, district.beautified};
            if (destroy_cost(military, other_wall) > state.players[player].gold) continue;
          } else {
            if (district.card.cost > state.players[player].gold) continue;
            const int same_name = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
              [&](const NativeDistrict& own) { return own.name == district.name; }));
            const int quarry = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
              [](const NativeDistrict& own) { return own.effect == "quarry"; }));
            if (same_name >= 1 + quarry) continue;
          }
          actions.push_back({ActionType::ChooseDistrict, district.card.uid, {}, {}, state.players[i].id});
        }
      }
      if (actions.empty()) actions.push_back({ActionType::AbilitySkip});
      return actions;
    }
    if (state.pending_kind == "assassin" || state.pending_kind == "thief") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& id : state.char_deck) {
        const int number = char_number(id);
        if (number <= 0 || face_up_removed(state, number) ||
            number == char_number(state.players[player].role_id) ||
            (state.pending_kind == "thief" && number == 1)) continue;
        actions.push_back({ActionType::ChooseChar, {}, std::to_string(number), {}});
      }
      std::stable_sort(actions.begin(), actions.end(), [](const auto& left, const auto& right) {
        return std::stoi(left.name) < std::stoi(right.name);
      });
      return actions;
    }
    if (state.pending_kind == "witch_target") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& id : state.char_deck) {
        const int number = char_number(id);
        if (number > 0 && number != 1 && number != char_number(state.players[player].role_id) &&
            !face_up_removed(state, number))
          actions.push_back({ActionType::ChooseChar, {}, std::to_string(number), {}});
      }
      std::stable_sort(actions.begin(), actions.end(), [](const auto& left, const auto& right) {
        return std::stoi(left.name) < std::stoi(right.name);
      });
      return actions;
    }
    if (state.phase == NativePhase::Draft) {
      if (player != state.draft_current_player || state.draft_step < 0 ||
          state.draft_step >= static_cast<int>(state.draft_steps.size())) return {};
      std::vector<NativeSearchAction> actions;
      const auto& step = state.draft_steps[state.draft_step];
      std::vector<std::string> pool = state.draft_pool;
      if (step.from_face_down && state.draft_sub == "pick")
        pool.insert(pool.end(), state.draft_face_down.begin(), state.draft_face_down.end());
      for (const auto& id : pool) actions.push_back({
        state.draft_sub == "pick" ? ActionType::DraftPick : ActionType::DraftDiscard, id, {}, {}});
      if (state.draft_sub == "discard") {
        actions.erase(std::remove_if(actions.begin(), actions.end(), [&](const auto& action) {
          return char_number(action.uid) == 4;
        }), actions.end());
      }
      return actions;
    }
    if (player != state.active_player) return {};
    const auto* p = player >= 0 && player < static_cast<int>(state.players.size())
                        ? &state.players[player] : nullptr;
    if (!p) return {};
    std::vector<NativeSearchAction> actions;
    if (!state.resources_taken) {
      actions.push_back({ActionType::TakeGold});
      actions.push_back({ActionType::TakeCards});
    }
    if (state.resources_taken && !state.ability_used && state.pending_kind.empty()) {
      const auto& role = state.players[player].role_id;
      if (role == "assassin" || role == "thief" || role == "magician" || role == "emperor" ||
          role == "diplomat" || role == "warlord" || role == "marshal" || role == "artist" ||
          role == "navigator" || role == "scholar" || role == "prophet") {
        // JS marks diplomat's ability disabled when the player has no city;
        // training.enumerateLegalActions removes disabled actions.
        if ((role != "diplomat" || !p->city.empty()) &&
            (role != "navigator" || !state.bonus_done)) actions.push_back({ActionType::Ability});
      }
    }
    if (state.resources_taken && !state.income_taken) {
      if (state.players[player].role_id == "king" || state.players[player].role_id == "emperor" ||
          state.players[player].role_id == "noble" ||
          state.players[player].role_id == "bishop" || state.players[player].role_id == "merchant" ||
          state.players[player].role_id == "businessman" ||
          state.players[player].role_id == "warlord" || state.players[player].role_id == "diplomat" ||
          state.players[player].role_id == "marshal")
        actions.push_back({ActionType::Income});
    }
    if (state.resources_taken && state.income_taken && !state.monk_extra_taken &&
        state.players[player].role_id == "monk") {
      int richest = -1;
      for (size_t i = 0; i < state.players.size(); ++i) {
        if (static_cast<int>(i) == player) continue;
        if (richest < 0 || state.players[i].gold > state.players[richest].gold)
          richest = static_cast<int>(i);
      }
      if (richest >= 0 && state.players[richest].gold > p->gold)
        actions.push_back({ActionType::MonkTake});
    }
    if (state.resources_taken) {
      for (const auto& card : p->hand) {
        if (can_build(state, *p, card))
          actions.push_back({ActionType::Build, card.uid, card.name, card.purple_effect});
      }
      for (const auto& d : p->city) {
        if (d.effect == "lab" && !state.used_lab && !p->hand.empty())
          for (const auto& card : p->hand) actions.push_back({ActionType::Lab, d.card.uid, {}, {}, {}, {}, card.uid});
        if (d.effect == "smithy" && !state.used_smithy && p->gold >= 2)
          actions.push_back({ActionType::Smithy, d.card.uid, {}, {}});
        if (d.effect == "museum" && !state.used_museum && !p->hand.empty())
          for (const auto& card : p->hand) actions.push_back({ActionType::Museum, d.card.uid, {}, {}, {}, {}, card.uid});
      }
      actions.push_back({ActionType::EndTurn});
    }
    return actions;
  }

  bool apply(NativeGameState& state, int player,
             const NativeSearchAction& action) const override {
    if (action.type == ActionType::ConfirmRound)
      return state.confirm_round(player);
    if (action.type == ActionType::AbilitySkip) {
      if (player != state.active_player || state.pending_kind.empty()) return false;
      state.pending_kind.clear(); state.pending_queue.clear(); state.pending_cards.clear();
      state.pending_selected.clear(); state.pending_target = -1; state.pending_uid.clear();
      state.ability_used = true;
      return true;
    }
    if (action.type == ActionType::Reaction && state.reaction_kind == "graveyard") {
      if (player != state.reaction_player) return false;
      return state.reaction(action.name == "use");
    }
    if (action.type == ActionType::MagicianMode && state.pending_kind == "magician_choice") {
      if (player != state.active_player || (action.name != "swap" && action.name != "redraw")) return false;
      state.pending_kind = action.name == "swap" ? "magician_swap" : "magician_redraw";
      return true;
    }
    if (action.type == ActionType::ChoosePlayer && state.pending_kind == "magician_swap") {
      if (player != state.active_player) return false;
      int target = -1;
      for (size_t i = 0; i < state.players.size(); ++i)
        if (state.players[i].id == action.target) target = static_cast<int>(i);
      if (target < 0 || target == player) return false;
      MagicianHands hands{std::move(state.players[player].hand), std::move(state.players[target].hand)};
      magician_swap(hands);
      state.players[player].hand = std::move(hands.mine);
      state.players[target].hand = std::move(hands.target);
      state.pending_kind.clear();
      state.ability_used = true;
      return true;
    }
    if (action.type == ActionType::ChooseCards && state.pending_kind == "magician_redraw") {
      const bool ok = player == state.active_player && state.magician_redraw(action.selected_uids);
      if (ok) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::EmperorCrown && state.pending_kind == "emperor_crown") {
      if (player != state.active_player) return false;
      int target = -1;
      for (size_t i = 0; i < state.players.size(); ++i)
        if (state.players[i].id == action.target) target = static_cast<int>(i);
      if (!state.transfer_crown(target)) return false;
      state.pending_kind = "emperor_take";
      return true;
    }
    if (action.type == ActionType::EmperorTake && state.pending_kind == "emperor_take") {
      const bool ok = action.name == "gold" ? state.emperor_take_gold() :
        (action.name == "card" ? state.emperor_take_card() : false);
      if (ok) { state.pending_kind.clear(); state.ability_used = true; }
      return ok;
    }
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "diplomat_mine") {
      if (player != state.active_player) return false;
      const auto it = std::find_if(state.players[player].city.begin(), state.players[player].city.end(),
        [&](const NativeDistrict& d) { return d.card.uid == action.uid && !d.fortress; });
      if (it == state.players[player].city.end()) return false;
      state.pending_uid = action.uid; state.pending_kind = "diplomat_theirs";
      return true;
    }
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "diplomat_theirs") {
      if (player != state.active_player) return false;
      const bool ok = state.diplomat_swap(action.target, action.uid);
      if (ok) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "warlord_destroy") {
      const bool ok = state.warlord_destroy(action.target, action.uid);
      if (ok) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "marshal_seize") {
      const bool ok = state.marshal_seize(action.target, action.uid);
      if (ok) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::NavigatorBonus && state.pending_kind == "navigator_bonus") {
      const bool ok = state.navigator_bonus(action.name);
      if (ok) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::MonkResource && state.pending_kind == "monk_declare") {
      int gold = -1, cards = -1;
      try { gold = std::stoi(action.name); cards = std::stoi(action.effect); } catch (...) { return false; }
      return state.monk_resource(gold, cards);
    }
    if ((action.type == ActionType::ScholarPick && state.pending_kind == "scholar_pick") ||
        (action.type == ActionType::DrawKeep && state.pending_kind == "draw_keep")) {
      if (player != state.active_player) return false;
      const bool ok = state.keep_pending_card(action.uid);
      if (ok && action.type == ActionType::ScholarPick) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::ProphetGive && state.pending_kind == "prophet_give")
      return player == state.active_player && state.prophet_give(action.uid);
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "artist")
      return player == state.active_player && state.artist_select(action.uid);
    if (action.type == ActionType::ArtistDone && state.pending_kind == "artist") {
      const bool ok = player == state.active_player && state.artist_done(action.selected_uids);
      if (ok) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::ChooseChar &&
        (state.pending_kind == "assassin" || state.pending_kind == "thief")) {
      if (player != state.active_player) return false;
      int number = -1;
      try { number = std::stoi(action.name); } catch (...) { return false; }
      bool known = false;
      for (const auto& id : state.char_deck) if (char_number(id) == number) known = true;
      if (!known || number < 1 || number > 8) return false;
      if (state.pending_kind == "assassin") state.assassinated = number;
      else { state.thief_target = number; state.thief_player = player; }
      state.pending_kind.clear();
      state.ability_used = true;
      return true;
    }
    if (action.type == ActionType::ChooseChar && state.pending_kind == "witch_target") {
      if (player != state.active_player) return false;
      int number = -1;
      try { number = std::stoi(action.name); } catch (...) { return false; }
      bool known = false;
      for (const auto& id : state.char_deck) if (char_number(id) == number) known = true;
      if (!known || number <= 1 || number == char_number(state.players[player].role_id)) return false;
      state.bewitched = number; state.witch_player = player;
      state.pending_kind.clear(); state.ability_used = true;
      return true;
    }
    if (state.phase == NativePhase::Draft) {
      if (player != state.draft_current_player) return false;
      if (action.type == ActionType::DraftPick && state.draft_sub == "pick") {
        if (!state.draft_remove(action.uid)) return false;
        state.players[player].role_ids.push_back(action.uid);
        state.players[player].role_id = action.uid;
        return state.advance_draft();
      }
      if (action.type == ActionType::DraftDiscard && state.draft_sub == "discard") {
        if (!state.draft_remove(action.uid)) return false;
        state.draft_face_down.push_back(action.uid);
        return state.advance_draft();
      }
      return false;
    }
    if (player != state.active_player) return false;
    switch (action.type) {
      case ActionType::TakeGold: return state.take_gold();
      case ActionType::TakeCards: return state.take_cards();
      case ActionType::Income: return state.income();
      case ActionType::MonkTake: return state.monk_take();
      case ActionType::Ability: return state.start_ability();
      case ActionType::Build: return state.build(action.uid, action.name);
      case ActionType::Lab: return state.use_lab(action.uid, action.secondary_uid);
      case ActionType::Smithy: return state.use_smithy(action.uid);
      case ActionType::Museum: return state.use_museum(action.uid, action.secondary_uid);
      case ActionType::EndTurn: return state.end_turn();
      default: return false;
    }
  }

  int next_player(const NativeGameState& state) const override {
    return state.active_player;
  }

  bool terminal(const NativeGameState& state) const override {
    return std::any_of(state.players.begin(), state.players.end(), [&](const NativePlayer& p) {
      return p.city.size() >= static_cast<size_t>(state.end_districts);
    });
  }

  float terminal_value(const NativeGameState& state, int player) const override {
    return native_terminal_reward(state, player);
  }

  std::array<float, kValueSlots> terminal_value_vector(
      const NativeGameState& state, int player) const override {
    return native_terminal_reward_vector(state, player);
  }
};

class UniformNativeEvaluator final : public Evaluator<NativeGameState, NativeSearchAction> {
 public:
  Evaluation evaluate(const NativeGameState&, int,
                      const std::vector<NativeSearchAction>& actions) override {
    Evaluation result;
    result.priors.assign(actions.size(), actions.empty() ? 0.0f
                                                           : 1.0f / actions.size());
    return result;
  }
};

}  // namespace citadels::native
