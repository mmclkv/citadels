#pragma once

#include <string>
#include <vector>

#include "game_state.hpp"
#include "mcts_core.hpp"

namespace citadels::native {

struct NativeSearchAction {
  ActionType type = ActionType::EndTurn;
  std::string uid;
  std::string name;
  std::string effect;
};

// 将统一原生状态接入通用 PUCT。这里的动作集合只暴露当前状态真正可执行的
// 基础资源、建造、紫色建筑能力和回合结束动作；更复杂的多步 pending 动作
// 继续沿用同一接口扩展，不在搜索核心里硬编码规则。
class NativeGameAdapter final : public GameAdapter<NativeGameState, NativeSearchAction> {
 public:
  std::vector<NativeSearchAction> legal_actions(const NativeGameState& state,
                                                int player) const override {
    if (player != state.active_player) return {};
    const auto* p = player >= 0 && player < static_cast<int>(state.players.size())
                        ? &state.players[player] : nullptr;
    if (!p) return {};
    std::vector<NativeSearchAction> actions;
    if (!state.resources_taken) {
      actions.push_back({ActionType::TakeGold});
      actions.push_back({ActionType::TakeCards});
    }
    if (state.resources_taken) {
      for (const auto& card : p->hand) {
        actions.push_back({ActionType::Build, card.uid, card.uid, {}});
      }
      for (const auto& d : p->city) {
        if (d.effect == "lab" && !state.used_lab && !p->hand.empty())
          actions.push_back({ActionType::Lab, d.card.uid, {}, {}});
        if (d.effect == "smithy" && !state.used_smithy && p->gold >= 2)
          actions.push_back({ActionType::Smithy, d.card.uid, {}, {}});
        if (d.effect == "museum" && !state.used_museum && !p->hand.empty())
          actions.push_back({ActionType::Museum, d.card.uid, p->hand.front().uid, {}});
      }
      actions.push_back({ActionType::EndTurn});
    }
    return actions;
  }

  bool apply(NativeGameState& state, int player,
             const NativeSearchAction& action) const override {
    if (player != state.active_player) return false;
    switch (action.type) {
      case ActionType::TakeGold: return state.take_gold();
      case ActionType::TakeCards: return state.take_cards();
      case ActionType::Build: return state.build(action.uid, action.name);
      case ActionType::Lab: return state.use_lab(action.uid, state.players[player].hand.front().uid);
      case ActionType::Smithy: return state.use_smithy(action.uid);
      case ActionType::Museum: return state.use_museum(action.uid, action.name);
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
