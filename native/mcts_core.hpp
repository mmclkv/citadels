#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <random>
#include <utility>
#include <vector>

namespace citadels::native {

template <typename State, typename Action>
struct GameAdapter {
  virtual ~GameAdapter() = default;
  virtual std::vector<Action> legal_actions(const State& state, int player) const = 0;
  virtual bool apply(State& state, int player, const Action& action) const = 0;
  virtual int next_player(const State& state) const = 0;
  virtual bool terminal(const State& state) const = 0;
  virtual float terminal_value(const State& state, int root_player) const = 0;
};

struct Evaluation {
  std::vector<float> priors;
  float value = 0.0f;
};

template <typename State, typename Action>
struct Evaluator {
  virtual ~Evaluator() = default;
  virtual Evaluation evaluate(const State& state, int player,
                              const std::vector<Action>& actions) = 0;
};

// 通用 PUCT 核心。State/Action 由规则适配层定义，搜索核心不依赖游戏规则。
template <typename State, typename Action>
class Mcts {
 public:
  struct Config {
    int simulations = 50;
    int max_depth = 400;
    float c_puct = 1.0f;
    uint32_t seed = 1;
  };

  struct Result {
    std::vector<float> policy;
    float value = 0.0f;
    int visits = 0;
    int expansions = 0;
  };

  Mcts(const GameAdapter<State, Action>& game,
       Evaluator<State, Action>& evaluator, Config config = {})
      : game_(game), evaluator_(evaluator), config_(config), rng_(config.seed) {}

  Result search(const State& root_state, int root_player) {
    expansions_ = 0;
    Node root;
    root.player = root_player;
    root.actions = game_.legal_actions(root_state, root_player);
    if (root.actions.empty()) return {};
    expand(root, root_state);

    for (int i = 0; i < config_.simulations; ++i) {
      State state = root_state;
      std::vector<Node*> path{&root};
      Node* node = &root;
      bool backed_up = false;
      for (int depth = 0; depth < config_.max_depth; ++depth) {
        if (game_.terminal(state)) {
          backup(path, game_.terminal_value(state, root_player), root_player);
          backed_up = true;
          break;
        }
        if (!node->expanded) {
          expand(*node, state);
          backup(path, node->value, root_player);
          backed_up = true;
          break;
        }
        const size_t index = select(*node);
        if (index >= node->actions.size() ||
            !game_.apply(state, node->player, node->actions[index])) {
          backup(path, node->value, root_player);
          backed_up = true;
          break;
        }
        if (!node->children[index]) {
          const int player = game_.next_player(state);
          node->children[index] = std::make_unique<Node>();
          node->children[index]->player = player;
          node->children[index]->actions = game_.legal_actions(state, player);
        }
        node = node->children[index].get();
        path.push_back(node);
      }
      if (!backed_up) backup(path, node->value, root_player);
    }

    Result result;
    result.policy.resize(root.actions.size(), 0.0f);
    for (size_t i = 0; i < root.children.size(); ++i) {
      if (root.children[i]) {
        result.policy[i] = static_cast<float>(root.children[i]->visits);
        result.visits += root.children[i]->visits;
      }
    }
    if (result.visits == 0) {
      result.policy = root.priors;
    } else {
      for (float& value : result.policy) value /= static_cast<float>(result.visits);
    }
    result.value = root.visits ? root.total / root.visits : root.value;
    result.expansions = expansions_;
    return result;
  }

 private:
  struct Node {
    int player = 0;
    std::vector<Action> actions;
    std::vector<float> priors;
    std::vector<std::unique_ptr<Node>> children;
    float total = 0.0f;
    float value = 0.0f;
    int visits = 0;
    bool expanded = false;
  };

  void expand(Node& node, const State& state) {
    if (node.expanded) return;
    Evaluation evaluation = evaluator_.evaluate(state, node.player, node.actions);
    node.priors = std::move(evaluation.priors);
    if (node.priors.size() != node.actions.size()) {
      node.priors.assign(node.actions.size(), 1.0f / node.actions.size());
    }
    node.value = evaluation.value;
    node.children.resize(node.actions.size());
    node.expanded = true;
    ++expansions_;
  }

  size_t select(const Node& node) {
    size_t best = 0;
    float best_score = -std::numeric_limits<float>::infinity();
    const float parent = static_cast<float>(std::max(1, node.visits));
    for (size_t i = 0; i < node.actions.size(); ++i) {
      const Node* child = node.children[i].get();
      const float visits = child ? static_cast<float>(child->visits) : 0.0f;
      const float q = child && child->visits ? child->total / child->visits : 0.0f;
      const float p = i < node.priors.size() ? node.priors[i] : 0.0f;
      const float u = config_.c_puct * p * std::sqrt(parent) / (1.0f + visits);
      const float score = q + u + (visits == 0 ? 1e-5f * random_unit() : 0.0f);
      if (score > best_score) { best_score = score; best = i; }
    }
    return best;
  }

  void backup(const std::vector<Node*>& path, float value, int root_player) {
    for (Node* node : path) {
      node->total += value * (node->player == root_player ? 1.0f : -1.0f);
      ++node->visits;
    }
  }

  float random_unit() { return std::generate_canonical<float, 24>(rng_); }

  const GameAdapter<State, Action>& game_;
  Evaluator<State, Action>& evaluator_;
  Config config_;
  std::mt19937 rng_;
  int expansions_ = 0;
};

}  // namespace citadels::native
