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
struct BatchedEvaluator {
  virtual ~BatchedEvaluator() = default;
  virtual Evaluation evaluate(const State& state, int player,
                              const std::vector<Action>& actions) = 0;
  virtual std::vector<Evaluation> evaluate_batch(
      const std::vector<State>& states, const std::vector<int>& players,
      const std::vector<std::vector<Action>>& actions) {
    std::vector<Evaluation> result;
    result.reserve(states.size());
    for (size_t i = 0; i < states.size(); ++i)
      result.push_back(evaluate(states[i], players[i], actions[i]));
    return result;
  }
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

// 分批叶节点评估版本。每个 batch 先完成树上选择和状态复制，再调用一次
// BatchedEvaluator::evaluate_batch，适合把多个搜索叶节点送入 GPU。
template <typename State, typename Action>
class BatchedMcts {
 public:
  using Config = typename Mcts<State, Action>::Config;
  using Result = typename Mcts<State, Action>::Result;

  BatchedMcts(const GameAdapter<State, Action>& game,
              BatchedEvaluator<State, Action>& evaluator, Config config = {})
      : game_(game), evaluator_(evaluator), config_(config) {}

  Result search(const State& root_state, int root_player, int batch_size) {
    if (batch_size < 1) batch_size = 1;
    Node root;
    root.player = root_player;
    root.actions = game_.legal_actions(root_state, root_player);
    if (root.actions.empty()) return {};
    expand(root, root_state);
    for (int offset = 0; offset < config_.simulations; offset += batch_size) {
      const int count = std::min(batch_size, config_.simulations - offset);
      std::vector<State> states;
      std::vector<int> players;
      std::vector<std::vector<Action>> actions;
      std::vector<std::vector<Node*>> paths;
      std::vector<float> terminal_values;
      std::vector<bool> terminal;
      for (int i = 0; i < count; ++i) {
        State state = root_state;
        Node* node = &root;
        std::vector<Node*> path{&root};
        bool collected = false;
        for (int depth = 0; depth < config_.max_depth; ++depth) {
          if (game_.terminal(state)) {
            terminal.push_back(true); terminal_values.push_back(game_.terminal_value(state, root_player));
            paths.push_back(std::move(path)); collected = true; break;
          }
          if (!node->expanded) {
            terminal.push_back(false); terminal_values.push_back(0.0f);
            states.push_back(std::move(state)); players.push_back(node->player);
            actions.push_back(node->actions); paths.push_back(std::move(path));
            collected = true; break;
          }
          const size_t index = select(*node);
          if (index >= node->actions.size() ||
              !game_.apply(state, node->player, node->actions[index])) {
            terminal.push_back(true); terminal_values.push_back(node->value);
            paths.push_back(std::move(path)); collected = true; break;
          }
          if (!node->children[index]) {
            node->children[index] = std::make_unique<Node>();
            node->children[index]->player = game_.next_player(state);
            node->children[index]->actions = game_.legal_actions(state, node->children[index]->player);
          }
          node = node->children[index].get();
          path.push_back(node);
        }
        if (!collected) {
          terminal.push_back(true); terminal_values.push_back(node->value);
          paths.push_back(std::move(path));
        }
      }
      std::vector<Evaluation> evaluations;
      if (!states.empty()) evaluations = evaluator_.evaluate_batch(states, players, actions);
      size_t eval_index = 0;
      for (size_t i = 0; i < paths.size(); ++i) {
        float value = terminal_values[i];
        if (!terminal[i] && eval_index < evaluations.size()) {
          value = evaluations[eval_index].value;
          expand(*paths[i].back(), states[eval_index], evaluations[eval_index]);
          ++eval_index;
        }
        backup(paths[i], value, root_player);
      }
    }
    return result(root);
  }

 private:
  struct Node {
    int player = 0; std::vector<Action> actions; std::vector<float> priors;
    std::vector<std::unique_ptr<Node>> children; float total = 0; float value = 0;
    int visits = 0; bool expanded = false;
  };
  void expand(Node& node, const State& state) {
    auto evaluation = evaluator_.evaluate(state, node.player, node.actions);
    expand(node, state, evaluation);
  }
  void expand(Node& node, const State&, const Evaluation& evaluation) {
    node.priors = evaluation.priors;
    if (node.priors.size() != node.actions.size())
      node.priors.assign(node.actions.size(), 1.0f / node.actions.size());
    node.value = evaluation.value; node.children.resize(node.actions.size()); node.expanded = true;
  }
  size_t select(const Node& node) const {
    size_t best = 0; float score_best = -std::numeric_limits<float>::infinity();
    const float parent = static_cast<float>(std::max(1, node.visits));
    for (size_t i = 0; i < node.actions.size(); ++i) {
      const Node* child = node.children[i].get();
      const float visits = child ? static_cast<float>(child->visits) : 0.0f;
      const float q = child && child->visits ? child->total / child->visits : 0.0f;
      const float p = i < node.priors.size() ? node.priors[i] : 0.0f;
      const float score = q + config_.c_puct * p * std::sqrt(parent) / (1.0f + visits);
      if (score > score_best) { score_best = score; best = i; }
    }
    return best;
  }
  void backup(const std::vector<Node*>& path, float value, int root_player) {
    for (Node* node : path) { node->total += value * (node->player == root_player ? 1.0f : -1.0f); ++node->visits; }
  }
  Result result(const Node& root) const {
    Result output; output.policy.resize(root.actions.size(), 0.0f);
    for (size_t i = 0; i < root.children.size(); ++i) if (root.children[i]) {
      output.policy[i] = static_cast<float>(root.children[i]->visits); output.visits += root.children[i]->visits;
    }
    if (output.visits) for (float& value : output.policy) value /= output.visits;
    else output.policy = root.priors;
    output.value = root.visits ? root.total / root.visits : root.value;
    return output;
  }
  const GameAdapter<State, Action>& game_; BatchedEvaluator<State, Action>& evaluator_; Config config_;
};

}  // namespace citadels::native
