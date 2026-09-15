#pragma once

#include <string>
#include <vector>

#include "game_state.hpp"
#include "magician_machine.hpp"
#include "mcts_core.hpp"

namespace citadels::native {

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
    static const std::vector<std::string> ids = {
      "assassin", "thief", "magician", "king", "bishop", "merchant", "architect", "warlord"
    };
    const auto it = std::find(ids.begin(), ids.end(), id);
    return it == ids.end() ? -1 : static_cast<int>(it - ids.begin()) + 1;
  }

  std::vector<NativeSearchAction> legal_actions(const NativeGameState& state,
                                                int player) const override {
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
      return {{ActionType::ChooseCards}};
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
      for (const auto& district : state.players[player].city)
        if (!district.beautified && std::find(state.pending_selected.begin(), state.pending_selected.end(), district.card.uid) == state.pending_selected.end())
          actions.push_back({ActionType::ChooseDistrict, district.card.uid});
      actions.push_back({ActionType::ArtistDone, {}, {}, {}, {}, state.pending_selected});
      return actions;
    }
    if (state.pending_kind == "diplomat_theirs") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (size_t i = 0; i < state.players.size(); ++i) if (static_cast<int>(i) != player)
        for (const auto& district : state.players[i].city) if (!district.fortress)
          actions.push_back({ActionType::ChooseDistrict, district.card.uid, {}, {}, state.players[i].id});
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
          actions.push_back({ActionType::ChooseDistrict, district.card.uid, {}, {}, state.players[i].id});
        }
      }
      return actions;
    }
    if (state.pending_kind == "assassin" || state.pending_kind == "thief") {
      if (player != state.active_player) return {};
      std::vector<NativeSearchAction> actions;
      for (const auto& id : state.char_deck) {
        const int number = char_number(id);
        if (number > 0) actions.push_back({ActionType::ChooseChar, {}, std::to_string(number), {}});
      }
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
    if (state.resources_taken && !state.income_taken) {
      if (state.players[player].role_id == "king" || state.players[player].role_id == "noble" ||
          state.players[player].role_id == "bishop" || state.players[player].role_id == "merchant" ||
          state.players[player].role_id == "warlord" || state.players[player].role_id == "marshal")
        actions.push_back({ActionType::Income});
    }
    if (state.resources_taken && state.income_taken && !state.monk_extra_taken &&
        state.players[player].role_id == "monk") actions.push_back({ActionType::MonkTake});
    if (state.resources_taken) {
      for (const auto& card : p->hand) {
        actions.push_back({ActionType::Build, card.uid, card.name, {}});
      }
      for (const auto& d : p->city) {
        if (d.effect == "lab" && !state.used_lab)
          for (const auto& card : p->hand) actions.push_back({ActionType::Lab, d.card.uid, {}, {}, {}, {}, card.uid});
        if (d.effect == "smithy" && !state.used_smithy && p->gold >= 2)
          actions.push_back({ActionType::Smithy, d.card.uid, {}, {}});
        if (d.effect == "museum" && !state.used_museum)
          for (const auto& card : p->hand) actions.push_back({ActionType::Museum, d.card.uid, {}, {}, {}, {}, card.uid});
      }
      actions.push_back({ActionType::EndTurn});
    }
    return actions;
  }

  bool apply(NativeGameState& state, int player,
             const NativeSearchAction& action) const override {
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
      return true;
    }
    if (action.type == ActionType::ChooseCards && state.pending_kind == "magician_redraw")
      return player == state.active_player && state.magician_redraw(action.selected_uids);
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
      if (ok) state.pending_kind.clear();
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
      return state.diplomat_swap(action.target, action.uid);
    }
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "warlord_destroy")
      return state.warlord_destroy(action.target, action.uid);
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "marshal_seize")
      return state.marshal_seize(action.target, action.uid);
    if (action.type == ActionType::NavigatorBonus && state.pending_kind == "navigator_bonus")
      return state.navigator_bonus(action.name);
    if (action.type == ActionType::MonkResource && state.pending_kind == "monk_declare") {
      int gold = -1, cards = -1;
      try { gold = std::stoi(action.name); cards = std::stoi(action.effect); } catch (...) { return false; }
      return state.monk_resource(gold, cards);
    }
    if ((action.type == ActionType::ScholarPick && state.pending_kind == "scholar_pick") ||
        (action.type == ActionType::DrawKeep && state.pending_kind == "draw_keep")) {
      if (player != state.active_player) return false;
      return state.keep_pending_card(action.uid);
    }
    if (action.type == ActionType::ProphetGive && state.pending_kind == "prophet_give")
      return player == state.active_player && state.prophet_give(action.uid);
    if (action.type == ActionType::ChooseDistrict && state.pending_kind == "artist")
      return player == state.active_player && state.artist_select(action.uid);
    if (action.type == ActionType::ArtistDone && state.pending_kind == "artist")
      return player == state.active_player && state.artist_done(action.selected_uids);
    if (action.type == ActionType::ChooseChar &&
        (state.pending_kind == "assassin" || state.pending_kind == "thief")) {
      if (player != state.active_player) return false;
      int number = -1;
      try { number = std::stoi(action.name); } catch (...) { return false; }
      bool known = false;
      for (const auto& id : state.char_deck) if (char_number(id) == number) known = true;
      if (!known || number < 1 || number > 8) return false;
      if (state.pending_kind == "assassin") state.assassinated = number;
      else state.thief_target = number;
      state.pending_kind.clear();
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

  float terminal_value(const NativeGameState& state, int root_player) const override {
    if (root_player < 0 || root_player >= static_cast<int>(state.players.size())) return 0.0f;
    return state.players[root_player].city.size() >= static_cast<size_t>(state.end_districts)
             ? 1.0f : 0.0f;
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
