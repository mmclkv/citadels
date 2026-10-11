#pragma once

#include <algorithm>
#include <array>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

#include "game_state.hpp"
#include "magician_machine.hpp"
#include "mcts_core.hpp"
#include "state_features.hpp"

namespace citadels::native {

// Shared authoritative score used by terminal rewards and heuristic planning.
inline float native_player_score(const NativeGameState& state, int index) {
  const auto& player = state.players.at(static_cast<size_t>(index));
  constexpr std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
  float total = 0;
  int ghosts = 0;
  std::array<bool, 5> have{};
  for (const auto& d : player.city) {
    total += d.card.score_as > 0 ? d.card.score_as
      : d.card.score_value > 0 ? d.card.score_value : d.card.cost;
  }
  total += state.score_bonus(index);
  return total;
}

// Historical terminal reward implementation: scoreValue/cost
// building points, museum and beautification points, five-color bonus (with
// last-round ghost-town exclusion), and completion bonuses.
inline std::array<float, kValueSlots> native_terminal_reward_vector(
    const NativeGameState& state, int perspective_player) {
  std::array<float, kValueSlots> result{};
  if (perspective_player < 0 || perspective_player >= static_cast<int>(state.players.size())) return result;
  struct Score { int player = -1; float total = 0.0f; };
  std::vector<Score> scores;
  scores.reserve(state.players.size());
  for (size_t i = 0; i < state.players.size(); ++i) {
    scores.push_back({static_cast<int>(i), native_player_score(state, static_cast<int>(i))});
  }
  for (size_t rel = 0; rel < scores.size() && rel < kValueSlots; ++rel) {
    const int player = (perspective_player + static_cast<int>(rel)) % static_cast<int>(state.players.size());
    const float total = scores[static_cast<size_t>(player)].total;
    // Competition ranking: equal totals share a rank; the next rank skips
    // the tied places. Preserve this definition for rank statistics and CFR.
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

// Search/value training pursue first place; rank remains a small tiebreaking
// preference among losing positions. Keep the historical rank helpers above
// for arena statistics and CFR, which have a separate objective.
inline constexpr double kWinFirstWeight = 0.9;
inline constexpr const char* kValueObjective = "win-first-v1";
inline std::array<float,kValueSlots> native_win_terminal_reward_vector(
    const NativeGameState& state,int player) {
  auto values=native_terminal_reward_vector(state,player);
  if(player<0 || player>=static_cast<int>(state.players.size()))return values;
  for(size_t r=0;r<state.players.size() && r<kValueSlots;++r){
    const double win=values[r]==1.0f?1.0:-1.0;
    values[r]=static_cast<float>(kWinFirstWeight*win+(1-kWinFirstWeight)*values[r]);
  }
  return values;
}

struct NativeSearchAction {
  ActionType type = ActionType::EndTurn;
  std::string uid;
  std::string name;
  std::string effect;
  std::string target;
  std::vector<std::string> selected_uids;
  std::string secondary_uid;
  std::string mode;
  std::string color;
  int num = -1;
  int gold = -1;
  int cards = -1;
  bool use = false;
  bool has_num = false;
};

// 将统一原生状态接入通用 PUCT。这里的动作集合只暴露当前状态真正可执行的
// 基础资源、建造、紫色建筑能力和回合结束动作；更复杂的多步 pending 动作
// 继续沿用同一接口扩展，不在搜索核心里硬编码规则。
class NativeGameAdapter final : public GameAdapter<NativeGameState, NativeSearchAction> {
 public:
  static NativeSearchAction number_action(ActionType type, int number) {
    NativeSearchAction action; action.type = type; action.num = number; action.has_num = true; return action;
  }
  // 选角色类动作（刺客/盗贼/女巫目标等）：native 规则按 name（角色编号字符串）
  // 结算，而 JS 侧同一动作带的是 num 字段。两边都填上，worker 的
  // 「native 动作 vs JS 合法动作」对齐校验才不会全盘失配。
  static NativeSearchAction make_choose_char(int number) {
    NativeSearchAction action;
    action.type = ActionType::ChooseChar;
    action.name = std::to_string(number);
    action.num = number;
    action.has_num = true;
    return action;
  }
  static std::vector<int> blackmailer_candidates(const NativeGameState& state, int player, int excluded = -1) {
    std::vector<int> result;
    if (player < 0 || player >= static_cast<int>(state.players.size())) return result;
    for (const auto& id : state.char_deck) {
      const int n = char_number(id);
      if (n <= 1 || n == char_number(state.players[player].role_id) || n == excluded ||
          n == state.assassinated || n == state.bewitched || face_up_removed(state, n) ||
          std::find(state.magistrate_nums.begin(), state.magistrate_nums.end(), n) != state.magistrate_nums.end()) continue;
      if (std::find(result.begin(), result.end(), n) == result.end()) result.push_back(n);
    }
    std::sort(result.begin(), result.end());
    return result;
  }
  static int char_number(const std::string& id) {
    if (id == "assassin" || id == "witch") return 1;
    if (id == "magistrate") return 1;
    if (id == "thief") return 2;
    if (id == "spy" || id == "blackmailer") return 2;
    if (id == "magician" || id == "prophet") return 3;
    if (id == "wizard") return 3;
    if (id == "king" || id == "emperor" || id == "noble") return 4;
    if (id == "bishop" || id == "monk") return 5;
    if (id == "abbot") return 5;
    if (id == "merchant" || id == "alchemist" || id == "businessman") return 6;
    if (id == "architect" || id == "navigator" || id == "scholar") return 7;
    if (id == "warlord" || id == "diplomat" || id == "marshal") return 8;
    if (id == "queen" || id == "artist") return 9;
    if (id == "tax_collector") return 9;
    return -1;
  }

  static bool face_up_removed(const NativeGameState& state, int number) {
    return std::any_of(state.draft_face_up.begin(), state.draft_face_up.end(),
      [&](const std::string& id) { return char_number(id) == number; });
  }

  static bool can_build(const NativeGameState& state, const NativePlayer& player,
                        const DistrictCard& card) {
    return state.can_build_card(player, card);
  }

  static std::vector<std::vector<std::string>> exact_hand_choices(const NativePlayer& player,
      const std::string& excluded_uid, int count) {
    std::vector<std::vector<std::string>> result;
    std::vector<std::string> current;
    std::vector<std::string> available;
    for (const auto& card : player.hand) if (card.uid != excluded_uid) available.push_back(card.uid);
    if (count < 0 || count > static_cast<int>(available.size())) return result;
    const auto visit = [&](const auto& self, size_t start) -> void {
      if (static_cast<int>(current.size()) == count) { result.push_back(current); return; }
      for (size_t i = start; i < available.size(); ++i) {
        current.push_back(available[i]); self(self, i + 1); current.pop_back();
      }
    };
    visit(visit, 0);
    return result;
  }

  // Back is a human navigation control, not a strategic decision. Keep the
  // authoritative human action list and the existing feature schema intact.
  std::vector<NativeSearchAction> ai_actions(const NativeGameState& state, int player) const override {
    auto actions = legal_actions(state, player);
    actions.erase(std::remove_if(actions.begin(), actions.end(), [](const NativeSearchAction& action) {
      return action.type == ActionType::PendingBack ||
        (action.type == ActionType::DistrictEffect && action.name == "thieves_cancel");
    }), actions.end());
    return actions;
  }

  InformationSetKey no_progress_key(const NativeGameState& state, int player) const override {
    if (state.pending_kind != "wizard_card" && state.pending_kind != "wizard_choice") return {};
    // Scoped to reversible wizard navigation. These transitions do not change
    // rules, resources or randomness; use raw values, not lossy neural inputs.
    InformationSetKeyBuilder key;
    key.i32(player); key.i32(static_cast<int>(state.phase));
    key.i32(state.active_player); key.i32(state.round); key.i32(state.call_index);
    key.i32(state.turns_completed); key.string(state.turn_phase);
    key.string(state.pending_kind); key.i32(state.pending_target); key.string(state.pending_uid);
    key.i32(state.builds); key.i32(state.spent_on_build); key.u64(state.rng.state());
    key.boolean(state.resources_taken); key.boolean(state.income_taken); key.boolean(state.ability_used);
    key.u64(state.players.size());
    for (const auto& p : state.players) {
      key.string(p.id); key.string(p.role_id); key.i32(p.gold);
      key.u64(p.hand.size()); for (const auto& c : p.hand) key.string(c.uid);
      key.u64(p.city.size()); for (const auto& d : p.city) key.string(d.card.uid);
    }
    key.u64(state.pending_cards.size());
    for (const auto& c : state.pending_cards) key.string(c.uid);
    return key.finish();
  }

#include "district_actions.hpp"

  std::vector<NativeSearchAction> legal_actions(const NativeGameState& state,
                                                int player) const override {
    if (state.pending_kind == "lighthouse" || state.pending_kind == "bell_tower" || state.pending_kind == "theater_exchange" || state.pending_kind == "thieves_den" || state.pending_kind == "ballroom") return district_actions(state, player);
    if (state.turn_phase == "hospital" && state.pending_kind.empty()) {
      if (player != state.active_player) return {};
      return state.resources_taken ? std::vector<NativeSearchAction>{{ActionType::EndTurn}} : std::vector<NativeSearchAction>{{ActionType::TakeGold}, {ActionType::TakeCards}};
    }
    if (state.phase == NativePhase::RoundConfirm) {
      if (player < 0 || player >= static_cast<int>(state.players.size()) ||
          (state.round_confirmed.size() == state.players.size() && state.round_confirmed[player])) return {};
      return {{ActionType::ConfirmRound}};
    }
    if (state.reaction_kind == "graveyard") {
      if (player != state.reaction_player) return {};
      return {{ActionType::Reaction, {}, "use", {}}, {ActionType::Reaction, {}, "skip", {}}};
    }
    if (state.reaction_kind == "magistrate") {
      if (player != state.reaction_player) return {};
      return {{ActionType::Reaction, {}, "use", {}}, {ActionType::Reaction, {}, "skip", {}}};
    }
    if (state.reaction_kind == "blackmailer") {
      if (player != state.reaction_player) return {};
      return {{ActionType::Reaction, {}, "use", {}}, {ActionType::Reaction, {}, "skip", {}}};
    }
    if (state.pending_kind == "blackmailer_threat") {
      if (player != state.active_player) return {};
      return {{ActionType::BlackmailerBribe}, {ActionType::BlackmailerRefuse}};
    }
    if (state.pending_kind == "bishop_repay") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& uids : exact_hand_choices(state.players[player], state.pending_uid, state.pending_amount)) {
        NativeSearchAction action; action.type = ActionType::ChooseCards; action.selected_uids = uids;
        actions.push_back(std::move(action));
      }
      return actions;
    }
    if (state.pending_kind == "bishop_payer") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (size_t i = 0; i < state.players.size(); ++i) {
        if (static_cast<int>(i) == player || state.players[i].gold < state.pending_amount) continue;
        NativeSearchAction action; action.type = ActionType::ChoosePlayer;
        action.target = state.players[i].id;
        actions.push_back(std::move(action));
      }
      return actions;
    }
    if (state.pending_kind == "magistrate_declare" || state.pending_kind == "magistrate_second" || state.pending_kind == "magistrate_third") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& id : state.char_deck) {
        const int n = char_number(id);
        const bool faceup = face_up_removed(state, n);
        if (n <= 0 || faceup || n == char_number(state.players[player].role_id) ||
            std::find(state.pending_nums.begin(), state.pending_nums.end(), n) != state.pending_nums.end()) continue;
        // First selection is the signed warrant; subsequent selections are decoys.
        actions.push_back(number_action(state.pending_kind == "magistrate_declare" ? ActionType::MagistrateSigned : ActionType::MagistrateChar, n));
      }
      std::sort(actions.begin(), actions.end(), [](const auto& a, const auto& b) { return a.num < b.num; });
      actions.erase(std::unique(actions.begin(), actions.end(), [](const auto& a, const auto& b) { return a.num == b.num; }), actions.end());
      if (actions.empty()) actions.push_back({ActionType::AbilitySkip});
      return actions;
    }
    if (state.pending_kind == "blackmailer_declare" || state.pending_kind == "blackmailer_second") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      const int excluded = state.pending_kind == "blackmailer_second" ? state.pending_first : -1;
      for (const int n : blackmailer_candidates(state, player, excluded)) actions.push_back(number_action(ActionType::BlackmailerChar, n));
      if (actions.empty()) actions.push_back({ActionType::AbilitySkip});
      return actions;
    }
    if (state.pending_kind == "blackmailer_signed") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const int n : state.pending_nums) actions.push_back(number_action(ActionType::BlackmailerSigned, n));
      return actions;
    }
    if (state.pending_kind == "spy_target" || state.pending_kind == "wizard_target") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (size_t i = 0; i < state.players.size(); ++i) if (static_cast<int>(i) != player) {
        // An empty hand cannot supply a card for the Wizard to select.
        if (state.pending_kind == "wizard_target" && state.players[i].hand.empty()) continue;
        NativeSearchAction action; action.type = state.pending_kind == "spy_target" ? ActionType::SpyTarget : ActionType::WizardTarget;
        action.target = state.players[i].id; actions.push_back(std::move(action));
      }
      // Also recover an already-pending selection with no eligible targets.
      if (state.pending_kind == "wizard_target" && actions.empty())
        actions.push_back({ActionType::AbilitySkip});
      return actions;
    }
    if (state.pending_kind == "spy_color") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& color : {"yellow", "blue", "green", "red", "purple"}) {
        NativeSearchAction action; action.type = ActionType::SpyColor; action.color = color; actions.push_back(std::move(action));
      }
      return actions;
    }
    if (state.pending_kind == "wizard_card") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& card : state.pending_cards) {
        NativeSearchAction action; action.type = ActionType::WizardCard;
        action.uid = card.uid; action.color = card.color;
        actions.push_back(std::move(action));
      }
      return actions;
    }
    if (state.pending_kind == "wizard_choice") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions{{ActionType::WizardTake}};
      const auto selected = std::find_if(state.pending_cards.begin(), state.pending_cards.end(),
        [&](const DistrictCard& card) { return card.uid == state.pending_uid; });
      if (selected != state.pending_cards.end() && state.active() &&
          state.can_build_card(*state.active(), *selected, false, true)) actions.push_back({ActionType::WizardBuild});
      actions.push_back({ActionType::PendingBack});
      return actions;
    }
    if (state.pending_kind == "abbot_declare") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (int gold = 0; gold <= state.blue_districts(player); ++gold) {
        NativeSearchAction action; action.type = ActionType::AbbotResource;
        action.gold = gold; action.cards = state.blue_districts(player) - gold; actions.push_back(std::move(action));
      }
      return actions;
    }
    if (state.pending_kind == "tax_collect") {
      if (player != state.active_player) return {};
      return {{ActionType::TaxCollect}};
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
      const auto& hand = state.players[player].hand;
      if (hand.empty()) return {{ActionType::ChooseCards, {}, {}, {}, {}, {}}};
      if (state.pending_cursor < 0 || state.pending_cursor >= static_cast<int>(hand.size())) return {};
      NativeSearchAction keep, discard;
      keep.type = discard.type = ActionType::ChooseCards;
      keep.uid = discard.uid = hand[state.pending_cursor].uid;
      keep.name = keep.mode = "skip";
      discard.name = discard.mode = "use";
      return {keep, discard};
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
      std::vector<NativeSearchAction> actions;
      for (const auto& mode : {"gold", "card"}) {
        NativeSearchAction action{ActionType::EmperorTake, {}, mode, {}};
        action.mode = mode;
        actions.push_back(std::move(action));
      }
      return actions;
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
      const int blue = state.blue_districts(player);
      std::vector<NativeSearchAction> actions;
      for (int gold = 0; gold <= blue; ++gold) {
        NativeSearchAction action{ActionType::MonkResource};
        action.name = std::to_string(gold);
        action.effect = std::to_string(blue - gold);
        action.gold = gold;
        action.cards = blue - gold;
        actions.push_back(std::move(action));
      }
      return actions;
    }
    if (state.pending_kind == "scholar_pick" || state.pending_kind == "draw_keep") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& card : state.pending_cards) {
        NativeSearchAction action{state.pending_kind == "scholar_pick" ? ActionType::ScholarPick : ActionType::DrawKeep,
                                  card.uid, {}, {}, {}};
        action.color = card.color;
        actions.push_back(std::move(action));
      }
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
        for (size_t i = 0; i < state.players.size(); ++i) if (static_cast<int>(i) != player && state.city_count(static_cast<int>(i)) < state.completion_limit() && !state.protected_from_rank8(static_cast<int>(i)))
          for (const auto& district : state.players[i].city) {
            if (district.fortress || std::any_of(state.players[i].city.begin(), state.players[i].city.end(), [&](const NativeDistrict& d) { return d.card.uid != district.card.uid && d.name == mine_it->name; })) continue;
            const int same_name = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
              [&](const NativeDistrict& own) { return own.card.uid != state.pending_uid && own.name == district.name; }));
            if (same_name > 0) continue;
            const bool wall = std::any_of(state.players[i].city.begin(), state.players[i].city.end(), [&](const NativeDistrict& d) { return d.effect == "wallCost" && d.card.uid != district.card.uid; });
            if (std::max(0, district.card.cost + int(district.beautified) + int(wall) - mine_it->card.cost - int(mine_it->beautified)) > state.players[player].gold) continue;
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
        if (state.city_count(static_cast<int>(i)) >= state.completion_limit()) continue;
        if (static_cast<int>(i) != player && state.protected_from_rank8(static_cast<int>(i))) continue;
        for (const auto& district : state.players[i].city) {
          if (district.fortress || (state.pending_kind == "marshal_seize" && district.card.cost + int(district.beautified) > 3)) continue;
          if (state.pending_kind == "warlord_destroy") {
            const bool other_wall = std::any_of(state.players[i].city.begin(), state.players[i].city.end(),
              [&](const NativeDistrict& other) {
                return other.card.uid != district.card.uid && other.effect == "wallCost";
              });
            MilitaryCard military{district.name, district.card.cost, district.fortress, district.beautified};
            if (destroy_cost(military, other_wall) > state.players[player].gold) continue;
          } else {
            const bool wall = std::any_of(state.players[i].city.begin(), state.players[i].city.end(), [&](const NativeDistrict& d) { return d.effect == "wallCost" && d.card.uid != district.card.uid; });
            if (district.card.cost + int(district.beautified) + int(wall) > 3 || district.card.cost + int(district.beautified) + int(wall) > state.players[player].gold) continue;
            const int same_name = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
              [&](const NativeDistrict& own) { return own.card.uid != state.pending_uid && own.name == district.name; }));
            const int quarry = static_cast<int>(std::count_if(state.players[player].city.begin(), state.players[player].city.end(),
              [](const NativeDistrict& own) { return own.effect == "quarry"; }));
            if (same_name > 0) continue;
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
        actions.push_back(make_choose_char(number));
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
          actions.push_back(make_choose_char(number));
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
      const bool picking = state.draft_sub == "pick";
      for (const auto& id : pool) {
        // JS 侧的 draft_pick/draft_discard 只用 charId 标识角色，worker 收到后会
        // 把 charId 填到 name 上；这里同步把 name 也写上，动作列表
        // 才能与 JS 对齐（uid 仍保留，供 native 规则自行结算）。
        NativeSearchAction action;
        action.type = picking ? ActionType::DraftPick : ActionType::DraftDiscard;
        action.name = id;
        actions.push_back(action);
      }
      if (state.draft_sub == "discard") {
        actions.erase(std::remove_if(actions.begin(), actions.end(), [&](const auto& action) {
          return char_number(action.name) == 4;
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
      if (state.awaiting_blackmail()) return actions;
    }
    if (state.resources_taken && !state.ability_used && state.pending_kind.empty()) {
      const auto& role = state.players[player].role_id;
      if (role == "assassin" || role == "thief" || role == "magician" || role == "emperor" ||
          role == "diplomat" || role == "warlord" || role == "marshal" || role == "artist" ||
          role == "navigator" || role == "scholar" || role == "prophet" || role == "magistrate" ||
          role == "spy" || role == "blackmailer" || role == "wizard" || role == "tax_collector") {
        // JS marks diplomat's ability disabled when the player has no city;
        // training.enumerateLegalActions removes disabled actions.
        if ((role != "diplomat" || !p->city.empty()) &&
            (role != "navigator" || !state.bonus_done)) actions.push_back({ActionType::Ability});
      }
    }
    if (!state.income_taken && p->role_id == "monk" && state.turn_phase != "bewitched")
      actions.push_back({ActionType::Income});
    if (state.resources_taken && !state.income_taken) {
      if (state.players[player].role_id == "king" || state.players[player].role_id == "emperor" ||
          state.players[player].role_id == "bishop" || state.players[player].role_id == "abbot" || state.players[player].role_id == "merchant" ||
          state.players[player].role_id == "businessman" ||
          state.players[player].role_id == "warlord" || state.players[player].role_id == "diplomat" ||
          state.players[player].role_id == "marshal")
        actions.push_back({ActionType::Income});
    }
    if (!state.monk_extra_taken && p->role_id == "monk" && state.turn_phase != "bewitched") {
      int richest = -1;
      for (size_t i = 0; i < state.players.size(); ++i) {
        if (static_cast<int>(i) == player) continue;
        if (richest < 0 || state.players[i].gold > state.players[richest].gold)
          richest = static_cast<int>(i);
      }
      if (richest >= 0 && state.players[richest].gold > p->gold) {
        for (size_t i = 0; i < state.players.size(); ++i)
          if (static_cast<int>(i) != player && state.players[i].gold == state.players[richest].gold) {
            NativeSearchAction take{ActionType::MonkTake};take.target=state.players[i].id;
            actions.push_back(std::move(take));
          }
      }
    }
    if (state.resources_taken) {
      for (const auto& card : p->hand) {
        if (can_build(state, *p, card)) {
          NativeSearchAction action{ActionType::Build, card.uid, card.name, card.purple_effect};
          action.color = card.color;
          actions.push_back(std::move(action));
        }
        else if (p->role_id == "bishop" && state.building_cost(*p, card) > p->gold && p->hand.size() > 1) {
          const int cost = state.building_cost(*p, card);
          NativePlayer funded = *p; funded.gold = cost;
          if (!can_build(state, funded, card)) continue;
          const int shortfall = cost - p->gold;
          if (static_cast<int>(p->hand.size()) - 1 < shortfall) continue;
          bool has_payer = false;
          for (size_t payer = 0; payer < state.players.size(); ++payer) {
            if (static_cast<int>(payer) == player || state.players[payer].gold < shortfall) continue;
            has_payer = true; break;
          }
          if (has_payer) {
            NativeSearchAction action; action.type = ActionType::Build; action.uid = card.uid;
            action.name = card.name; action.effect = card.purple_effect;
            action.color = card.color;
            actions.push_back(std::move(action));
          }
        }
      }
      for (const auto& d : p->city) {
        if (d.effect == "lab" && !state.used_lab && !p->hand.empty())
          for (const auto& card : p->hand) actions.push_back({ActionType::Lab, d.card.uid, {}, {}, {}, {}, card.uid});
        if (d.effect == "smithy" && !state.used_smithy && p->gold >= 2)
          actions.push_back({ActionType::Smithy, d.card.uid, {}, {}});
        if (d.effect == "museum" && !state.used_museum && !p->hand.empty())
          for (const auto& card : p->hand) actions.push_back({ActionType::Museum, d.card.uid, {}, {}, {}, {}, card.uid});
      }
      auto buildings = district_actions(state, player);
      actions.insert(actions.end(), buildings.begin(), buildings.end());
      actions.push_back({ActionType::EndTurn});
    }
    return actions;
  }

  bool apply(NativeGameState& state, int player,
             const NativeSearchAction& action) const override {
    if (action.type == ActionType::DistrictEffect) return apply_district(state, player, action);
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
    if (action.type == ActionType::Reaction && state.reaction_kind == "magistrate") {
      if (player != state.reaction_player) return false;
      return state.resolve_build_reaction(action.name == "use");
    }
    if (action.type == ActionType::Reaction && state.reaction_kind == "blackmailer") {
      if (player != state.reaction_player) return false;
      return state.resolve_blackmailer(action.name == "use");
    }
    if (action.type == ActionType::BlackmailerBribe && state.pending_kind == "blackmailer_threat")
      return player == state.active_player && state.blackmailer_bribe();
    if (action.type == ActionType::BlackmailerRefuse && state.pending_kind == "blackmailer_threat")
      return player == state.active_player && state.blackmailer_refuse();
    if ((action.type == ActionType::MagistrateSigned || action.type == ActionType::MagistrateChar) &&
        player == state.active_player && action.has_num) {
      const int n = action.num;
      if (n <= 0 || n == char_number(state.players[player].role_id) || face_up_removed(state, n) ||
          std::find(state.pending_nums.begin(), state.pending_nums.end(), n) != state.pending_nums.end()) return false;
      if (action.type == ActionType::MagistrateSigned && state.pending_kind == "magistrate_declare") {
        state.pending_signed = n; state.pending_nums = {n}; state.pending_kind = "magistrate_second"; return true;
      }
      if (action.type == ActionType::MagistrateChar &&
          (state.pending_kind == "magistrate_second" || state.pending_kind == "magistrate_third")) {
        state.pending_nums.push_back(n);
        if (state.pending_nums.size() < 3) { state.pending_kind = "magistrate_third"; return true; }
        state.magistrate_nums = state.pending_nums; state.magistrate_signed = state.pending_signed;
        state.magistrate_player = player; state.magistrate_claimed = false;
        state.pending_nums.clear(); state.pending_signed = -1; state.pending_kind.clear(); state.ability_used = true;
        return true;
      }
      return false;
    }
    if (action.type == ActionType::BlackmailerChar && player == state.active_player && action.has_num &&
        (state.pending_kind == "blackmailer_declare" || state.pending_kind == "blackmailer_second")) {
      const int n = action.num;
      const int excluded = state.pending_kind == "blackmailer_second" ? state.pending_first : -1;
      const auto candidates = blackmailer_candidates(state, player, excluded);
      if (std::find(candidates.begin(), candidates.end(), n) == candidates.end()) return false;
      if (state.pending_kind == "blackmailer_declare") {
        state.pending_first = n; state.pending_kind = candidates.size() > 1 ? "blackmailer_second" : "blackmailer_signed";
        state.pending_nums = candidates.size() > 1 ? std::vector<int>{} : std::vector<int>{n};
        return true;
      }
      state.pending_nums = {state.pending_first, n}; state.pending_kind = "blackmailer_signed"; return true;
    }
    if (action.type == ActionType::BlackmailerSigned && player == state.active_player && action.has_num &&
        state.pending_kind == "blackmailer_signed" &&
        std::find(state.pending_nums.begin(), state.pending_nums.end(), action.num) != state.pending_nums.end()) {
      state.blackmailer_nums = state.pending_nums; state.blackmailer_signed = action.num;
      state.blackmailer_player = player; state.blackmailer_done.clear();
      state.pending_nums.clear(); state.pending_first = -1; state.pending_kind.clear(); state.ability_used = true; return true;
    }
    if (action.type == ActionType::SpyTarget && player == state.active_player && state.pending_kind == "spy_target") {
      const int target = state.find_player(action.target);
      if (target < 0 || target == player) return false;
      state.pending_target = target; state.pending_kind = "spy_color"; return true;
    }
    if (action.type == ActionType::SpyColor && player == state.active_player && state.pending_kind == "spy_color" &&
        state.pending_target >= 0 && state.pending_target < static_cast<int>(state.players.size()))
      return state.spy_collect(state.players[state.pending_target].id, action.color);
    if (action.type == ActionType::WizardTarget && player == state.active_player && state.pending_kind == "wizard_target") {
      const int target = state.find_player(action.target);
      if (target < 0 || target == player || state.players[target].hand.empty()) return false;
      state.pending_target = target; state.pending_uid.clear();
      state.pending_cards = state.players[target].hand; state.pending_kind = "wizard_card"; return true;
    }
    if (action.type == ActionType::WizardCard && player == state.active_player && state.pending_kind == "wizard_card") {
      const auto it = std::find_if(state.pending_cards.begin(), state.pending_cards.end(), [&](const DistrictCard& c) { return c.uid == action.uid; });
      if (it == state.pending_cards.end()) return false;
      state.pending_uid = it->uid; state.pending_kind = "wizard_choice"; return true;
    }
    if (action.type == ActionType::PendingBack && player == state.active_player &&
        state.pending_kind == "wizard_choice" && state.pending_target >= 0 &&
        state.pending_target < static_cast<int>(state.players.size())) {
      state.pending_cards = state.players[state.pending_target].hand;
      state.pending_uid.clear();
      state.pending_kind = "wizard_card";
      return !state.pending_cards.empty();
    }
    if (action.type == ActionType::WizardTake && player == state.active_player && state.pending_kind == "wizard_choice") return state.wizard_take(false);
    if (action.type == ActionType::WizardBuild && player == state.active_player && state.pending_kind == "wizard_choice") return state.wizard_take(true);
    if (action.type == ActionType::AbbotResource && player == state.active_player && state.pending_kind == "abbot_declare")
      return state.abbot_resource(action.gold, action.cards);
    if (action.type == ActionType::TaxCollect && player == state.active_player && state.pending_kind == "tax_collect")
      return state.tax_collect();
    if (action.type == ActionType::MagicianMode && state.pending_kind == "magician_choice") {
      if (player != state.active_player || (action.name != "swap" && action.name != "redraw")) return false;
      state.pending_kind = action.name == "swap" ? "magician_swap" : "magician_redraw";
      state.pending_cursor = 0;
      state.pending_selected.clear();
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
    if (action.type == ActionType::ChoosePlayer && state.pending_kind == "bishop_payer") {
      if (player != state.active_player) return false;
      const int payer = state.find_player(action.target);
      if (payer < 0 || payer == player || state.players[payer].gold < state.pending_amount) return false;
      const auto card = std::find_if(state.players[player].hand.begin(), state.players[player].hand.end(),
        [&](const DistrictCard& value) { return value.uid == state.pending_uid; });
      if (card == state.players[player].hand.end()) return false;
      NativePlayer funded = state.players[player]; funded.gold = state.building_cost(funded, *card);
      if (!can_build(state, funded, *card)) return false;
      state.pending_target = payer;
      state.pending_kind = "bishop_repay";
      return true;
    }
    if (action.type == ActionType::ChooseCards && state.pending_kind == "magician_redraw") {
      if (player != state.active_player) return false;
      if (action.mode == "use" || action.mode == "skip") {
        if (state.pending_cursor < 0 || state.pending_cursor >= static_cast<int>(state.players[player].hand.size()) ||
            action.uid != state.players[player].hand[state.pending_cursor].uid) return false;
        if (action.mode == "use") state.pending_selected.push_back(action.uid);
        ++state.pending_cursor;
        if (state.pending_cursor < static_cast<int>(state.players[player].hand.size())) return true;
      }
      const bool ok = state.magician_redraw(action.mode.empty() ? action.selected_uids : state.pending_selected);
      if (ok) { state.pending_cursor = 0; state.pending_selected.clear(); }
      if (ok) state.ability_used = true;
      return ok;
    }
    if (action.type == ActionType::ChooseCards && state.pending_kind == "bishop_repay") {
      if (player != state.active_player || static_cast<int>(action.selected_uids.size()) != state.pending_amount ||
          state.pending_target < 0 || state.pending_target >= static_cast<int>(state.players.size())) return false;
      auto& builder = state.players[player];
      auto& payer = state.players[state.pending_target];
      auto building = std::find_if(builder.hand.begin(), builder.hand.end(), [&](const DistrictCard& card) {
        return card.uid == state.pending_uid;
      });
      if (building == builder.hand.end() || payer.gold < state.pending_amount) return false;
      std::vector<DistrictCard> payment;
      for (const auto& uid : action.selected_uids) {
        if (uid == state.pending_uid || std::any_of(payment.begin(), payment.end(), [&](const DistrictCard& c) { return c.uid == uid; })) return false;
        auto it = std::find_if(builder.hand.begin(), builder.hand.end(), [&](const DistrictCard& card) { return card.uid == uid; });
        if (it == builder.hand.end()) return false;
        payment.push_back(*it);
      }
      const int amount = state.pending_amount;
      const std::string build_uid = state.pending_uid;
      const DistrictCard build_card = *building;
      const int payer_index = state.pending_target;
      payer.gold -= amount;
      builder.gold += amount;
      builder.hand.erase(std::remove_if(builder.hand.begin(), builder.hand.end(), [&](const DistrictCard& card) {
        return std::find(action.selected_uids.begin(), action.selected_uids.end(), card.uid) != action.selected_uids.end();
      }), builder.hand.end());
      payer.hand.insert(payer.hand.end(), payment.begin(), payment.end());
      state.pending_kind.clear(); state.pending_uid.clear(); state.pending_target = -1; state.pending_amount = 0;
      const int builder_num = char_number(builder.role_id);
      if (state.magistrate_player >= 0 && !state.magistrate_claimed && state.magistrate_signed == builder_num &&
          state.magistrate_player != player &&
          std::none_of(state.players[state.magistrate_player].city.begin(), state.players[state.magistrate_player].city.end(),
            [&](const NativeDistrict& district) { return district.name == build_card.name; })) {
        state.magistrate_claimed = true;
        state.reaction_kind = "magistrate"; state.reaction_player = state.magistrate_player;
        state.reaction_target = state.magistrate_player; state.reaction_uid = build_uid; state.reaction_build = true;
        return true;
      }
      return state.build(build_uid, build_card.name, build_card.purple_effect);
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
      if (player != state.active_player) return false;
      const auto& mode = action.name.empty() ? action.mode : action.name;
      const bool ok = mode == "gold" ? state.emperor_take_gold() :
        (mode == "card" ? state.emperor_take_card() : false);
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
      if (player != state.active_player) return false;
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
      // Alternate character sets include rank-9 roles (e.g. Tax Collector,
      // Queen, Artist). legal_actions exposes them from char_deck, so the
      // executor must not reject them with the base-set 1..8 limit.
      if (!known || number <= 0) return false;
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
      // The declaration ends the Witch's initial turn. The selected role will
      // later resume the remainder of its turn for the Witch.
      state.turn_phase = "witch_declared";
      return state.end_turn();
    }
    if (state.phase == NativePhase::Draft) {
      if (player != state.draft_current_player) return false;
      if (action.type == ActionType::DraftPick && state.draft_sub == "pick") {
        if (!state.draft_remove(action.name)) return false;
        state.players[player].role_ids.push_back(action.name);
        state.players[player].role_id = action.name;
        return state.advance_draft();
      }
      if (action.type == ActionType::DraftDiscard && state.draft_sub == "discard") {
        if (!state.draft_remove(action.name)) return false;
        state.draft_face_down.push_back(action.name);
        return state.advance_draft();
      }
      return false;
    }
    if (player != state.active_player) return false;
    switch (action.type) {
      case ActionType::TakeGold: return state.take_gold();
      case ActionType::TakeCards: return state.take_cards();
      case ActionType::Income: return state.income();
      case ActionType::MonkTake: {
        int target=-1;
        if (!action.target.empty()) {
          for (size_t i=0;i<state.players.size();++i)if(state.players[i].id==action.target)target=static_cast<int>(i);
          if (target<0)return false;
        }
        return state.monk_take(target);
      }
      case ActionType::Ability: return state.start_ability();
      case ActionType::Build: {
        if (state.players[player].role_id == "bishop") {
          const auto card = std::find_if(state.players[player].hand.begin(), state.players[player].hand.end(),
            [&](const DistrictCard& value) { return value.uid == action.uid; });
          if (card == state.players[player].hand.end()) return false;
          const int cost = state.building_cost(state.players[player], *card);
          if (cost > state.players[player].gold) {
            const int amount = cost - state.players[player].gold;
            if (static_cast<int>(state.players[player].hand.size()) - 1 < amount) return false;
            NativePlayer funded = state.players[player]; funded.gold = cost;
            if (!can_build(state, funded, *card)) return false;
            bool has_payer = false;
            for (size_t i = 0; i < state.players.size(); ++i)
              if (static_cast<int>(i) != player && state.players[i].gold >= amount) { has_payer = true; break; }
            if (!has_payer) return false;
            state.pending_kind = "bishop_payer"; state.pending_uid = card->uid;
            state.pending_target = -1; state.pending_amount = amount;
            return true;
          }
        }
        return state.start_build(action.uid);
      }
      case ActionType::Lab: return state.use_lab(action.uid, action.secondary_uid);
      case ActionType::Smithy: return state.use_smithy(action.uid);
      case ActionType::Museum: return state.use_museum(action.uid, action.secondary_uid);
      case ActionType::EndTurn: return state.end_turn();
      default: return false;
    }
  }

  int next_player(const NativeGameState& state) const override {
    if (state.pending_kind == "theater_exchange" && !state.pending_queue.empty()) return state.pending_queue.front();
    if (state.pending_kind == "lighthouse" || state.pending_kind == "bell_tower") return state.pending_target;
    if (!state.reaction_kind.empty()) return state.reaction_player;
    if (state.phase == NativePhase::Draft) return state.draft_current_player;
    if (state.phase == NativePhase::RoundConfirm) {
      for (size_t i = 0; i < state.players.size(); ++i)
        if (i >= state.round_confirmed.size() || !state.round_confirmed[i]) return static_cast<int>(i);
      return -1;
    }
    return state.active_player;
  }

  bool terminal(const NativeGameState& state) const override {
    return state.phase == NativePhase::GameOver;
  }

  float terminal_value(const NativeGameState& state, int player) const override {
    return native_win_terminal_reward_vector(state, player)[0];
  }

  std::array<float, kValueSlots> terminal_value_vector(
      const NativeGameState& state, int player) const override {
    return native_win_terminal_reward_vector(state, player);
  }

  InformationSetKey information_set_hash(const NativeGameState& state, int player) const override {
    // 与旧字符串 key 使用相同的可观察状态和动作字段，但直接写入双哈希，
    // 避免 ostringstream、浮点格式化、大字符串分配和字符串线性查找。
    InformationSetKeyBuilder builder;
    builder.i32(player);
    builder.string(state.pending_kind); builder.string(state.turn_phase);
    builder.i32(state.completion_limit()); builder.i32(state.first_to_finish);
    builder.u64(state.first_finishers.size());
    for (int owner : state.first_finishers) builder.i32(owner);
    builder.u64(state.enabled_bell_towers.size());
    for (const auto& uid : state.enabled_bell_towers) builder.string(uid);
    if (player == state.active_player) {
      builder.string(state.building_mode); builder.string(state.building_source);
      for (const auto& uid : state.building_cards) builder.string(uid);
    }
    if (state.pending_kind == "magician_redraw" && player == state.active_player) {
      builder.i32(state.pending_cursor);
      builder.u64(state.pending_selected.size());
      for (const auto& uid : state.pending_selected) builder.string(uid);
    }
    // Hash the richest observable representation. This keeps nodes distinct
    // whenever any supported policy version can distinguish own-hand cards,
    // public district identities, or public context; older policies may merely
    // leave some of these features unused.
    const auto features = encode_features(state, player, 8);
    builder.u64(features.size());
    for (float value : features) builder.floating(value);
    const auto actions = legal_actions(state, player);
    builder.u64(actions.size());
    for (const auto& action : actions) {
      builder.i32(static_cast<int>(action.type));
      builder.string(action.uid);
      builder.string(action.name);
      builder.string(action.effect);
      builder.string(action.target);
      builder.string(action.secondary_uid);
      builder.string(action.mode);
      builder.string(action.color);
      builder.i32(action.num);
      builder.i32(action.gold);
      builder.i32(action.cards);
      builder.boolean(action.use);
      builder.boolean(action.has_num);
      builder.u64(action.selected_uids.size());
      for (const auto& uid : action.selected_uids) builder.string(uid);
    }
    return builder.finish();
  }

  // 仅供旧调试调用方读取；搜索核心使用上面的紧凑 hash。
  std::string information_set_key(const NativeGameState& state, int player) const override {
    const auto key = information_set_hash(state, player);
    return std::to_string(key.lo) + ':' + std::to_string(key.hi);
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
