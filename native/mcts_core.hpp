#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <random>
#include <utility>
#include <vector>

namespace citadels::native {

constexpr size_t kValueSlots = 8;

template <typename State>
auto state_player_count(const State& state, int) -> decltype(state.players.size(), size_t()) {
  return state.players.size();
}

template <typename State>
size_t state_player_count(const State&, ...) { return 0; }

template <typename State, typename Action>
struct GameAdapter {
  virtual ~GameAdapter() = default;
  virtual std::vector<Action> legal_actions(const State& state, int player) const = 0;
  virtual bool apply(State& state, int player, const Action& action) const = 0;
  virtual int next_player(const State& state) const = 0;
  virtual bool terminal(const State& state) const = 0;
  virtual float terminal_value(const State& state, int root_player) const = 0;
  virtual std::array<float, kValueSlots> terminal_value_vector(
      const State& state, int player) const {
    std::array<float, kValueSlots> result{};
    result[0] = terminal_value(state, player);
    return result;
  }
};

struct Evaluation {
  std::vector<float> priors;
  float value = 0.0f;
  std::array<float, kValueSlots> value_vector{};
  bool has_value_vector = false;
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
    // 防止高深度/高并发配置造成搜索树耗尽进程内存。
    int max_nodes = 20000;
    float c_puct = 1.0f;
    uint32_t seed = 1;
  };

  struct Result {
    std::vector<float> policy;
    float value = 0.0f;
    std::array<float, kValueSlots> value_vector{};
    int visits = 0;
    int expansions = 0;
  };

  Mcts(const GameAdapter<State, Action>& game,
       Evaluator<State, Action>& evaluator, Config config = {})
      : game_(game), evaluator_(evaluator), config_(config), rng_(config.seed) {}

  // 单世界搜索：退化成「粒子池只有一份」。
  Result search(const State& root_state, int root_player) {
    return search(std::vector<State>{root_state}, root_player, {});
  }

  /**
   * 信息集搜索（ISMCTS）：root_states 是同一个公开局面的若干份「隐藏信息猜测」，
   * 每条模拟随机抽一份往下走，但所有粒子共用同一棵树、同一批统计量。
   *
   * 这与「每个世界各建一棵树再平均根访问分布」（PIMC）不同：PIMC 会因为
   * strategy fusion 选出一个在任一世界里都不最优的动作，而且模拟预算被切成
   * N 份，同一信息集的经验分散在 N 棵树上谁都攒不起统计量。
   *
   * 树能共用的前提：同一信息集内合法动作集恒定（由调用方校验），且叶节点评估
   * 只看得到公开信息（特征里是 hand_count 而不是牌面）。
   */
  Result search(const std::vector<State>& root_states, int root_player,
                const std::vector<float>& particle_weights = {}) {
    if (root_states.empty()) return {};
    roots_ = &root_states;
    weights_ = &particle_weights;
    weight_total_ = 0.0f;
    for (float weight : particle_weights) if (weight > 0.0f) weight_total_ += weight;
    if (weights_->size() != root_states.size()) weight_total_ = 0.0f;
    expansions_ = 0;
    node_count_ = 1;
    const State& seed_state = root_states.front();
    player_count_ = state_player_count(seed_state, 0);
    Node root;
    root.player = root_player;
    root.actions = game_.legal_actions(seed_state, root_player);
    if (root.actions.empty()) return {};
    expand(root, seed_state);

    for (int i = 0; i < config_.simulations; ++i) {
      // 每条模拟重新抽一个粒子：世界只在本次模拟内有效，不是被钉死在树上
      State state = root_states[pick_particle()];
      std::vector<Node*> path{&root};
      Node* node = &root;
      bool backed_up = false;
      for (int depth = 0; depth < config_.max_depth; ++depth) {
        if (game_.terminal(state)) {
          backup(path, game_.terminal_value_vector(state, node->player));
          backed_up = true;
          break;
        }
        if (!node->expanded) {
          expand(*node, state);
          backup(path, node->value_vector);
          backed_up = true;
          break;
        }
        const size_t index = select(*node);
        if (index >= node->actions.size() ||
            !game_.apply(state, node->player, node->actions[index])) {
          backup(path, node->value_vector);
          backed_up = true;
          break;
        }
        if (!node->children[index]) {
          if (node_count_ >= static_cast<size_t>(std::max(1, config_.max_nodes))) {
            backup(path, node->value_vector);
            backed_up = true;
            break;
          }
          const int player = game_.next_player(state);
          node->children[index] = std::make_unique<Node>();
          ++node_count_;
          node->children[index]->player = player;
          node->children[index]->actions = game_.legal_actions(state, player);
        }
        node = node->children[index].get();
        path.push_back(node);
      }
      if (!backed_up) backup(path, node->value_vector);
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
    if (root.visits) {
      for (size_t i = 0; i < kValueSlots; ++i) result.value_vector[i] = root.total[i] / root.visits;
    } else result.value_vector = root.value_vector;
    result.value = result.value_vector[0];
    result.expansions = expansions_;
    return result;
  }

 private:
  struct Node {
    int player = 0;
    std::vector<Action> actions;
    std::vector<float> priors;
    std::vector<std::unique_ptr<Node>> children;
    std::array<float, kValueSlots> total{};
    std::array<float, kValueSlots> value_vector{};
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
    node.value_vector = evaluation.has_value_vector ? evaluation.value_vector : std::array<float, kValueSlots>{};
    if (!evaluation.has_value_vector) node.value_vector[0] = evaluation.value;
    node.value = node.value_vector[0];
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
      const size_t slot = child && player_count_ ? relative_slot(child->player, node.player) : 0;
      const float q = child && child->visits ? child->total[slot] / child->visits : 0.0f;
      const float p = i < node.priors.size() ? node.priors[i] : 0.0f;
      const float u = config_.c_puct * p * std::sqrt(parent) / (1.0f + visits);
      const float score = q + u + (visits == 0 ? 1e-5f * random_unit() : 0.0f);
      if (score > best_score) { best_score = score; best = i; }
    }
    return best;
  }

  size_t relative_slot(int perspective, int target) const {
    if (!player_count_) return 0;
    return (static_cast<size_t>((target - perspective + static_cast<int>(player_count_)) %
                                static_cast<int>(player_count_))) % kValueSlots;
  }

  void backup(const std::vector<Node*>& path,
              const std::array<float, kValueSlots>& value) {
    const int leaf_player = path.back()->player;
    for (Node* node : path) {
      if (!player_count_) {
        node->total[0] += value[0] * (node->player == leaf_player ? 1.0f : -1.0f);
      } else {
        for (size_t rel = 0; rel < kValueSlots && rel < player_count_; ++rel) {
          const int target = (node->player + static_cast<int>(rel)) % static_cast<int>(player_count_);
          node->total[rel] += value[relative_slot(leaf_player, target)];
        }
      }
      ++node->visits;
    }
  }

  float random_unit() { return std::generate_canonical<float, 24>(rng_); }

  // 按权重抽一个粒子；权重缺失 / 全 0 / 长度对不上时退化为均匀采样
  size_t pick_particle() {
    const size_t n = roots_ ? roots_->size() : 0;
    if (n <= 1) return 0;
    if (weight_total_ > 0.0f) {
      std::uniform_real_distribution<float> dist(0.0f, weight_total_);
      float remaining = dist(rng_);
      for (size_t i = 0; i < n; ++i) {
        remaining -= (*weights_)[i] > 0.0f ? (*weights_)[i] : 0.0f;
        if (remaining <= 0.0f) return i;
      }
      return n - 1;
    }
    std::uniform_int_distribution<size_t> dist(0, n - 1);
    return dist(rng_);
  }

  const GameAdapter<State, Action>& game_;
  Evaluator<State, Action>& evaluator_;
  Config config_;
  std::mt19937 rng_;
  const std::vector<State>* roots_ = nullptr;
  const std::vector<float>* weights_ = nullptr;
  float weight_total_ = 0.0f;
  int expansions_ = 0;
  size_t node_count_ = 0;
  size_t player_count_ = 0;
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

  // 单世界搜索：退化成「粒子池只有一份」。
  Result search(const State& root_state, int root_player, int batch_size) {
    return search(std::vector<State>{root_state}, root_player, batch_size, {});
  }

  /**
   * 信息集搜索（ISMCTS），语义同 Mcts::search 的粒子池版本：整池共用一棵树，
   * 每条模拟抽一份。分批评估只在「收集叶节点」这一层做，不影响粒子语义。
   */
  Result search(const std::vector<State>& root_states, int root_player, int batch_size,
                const std::vector<float>& particle_weights = {}) {
    if (batch_size < 1) batch_size = 1;
    if (root_states.empty()) return {};
    roots_ = &root_states;
    weights_ = &particle_weights;
    weight_total_ = 0.0f;
    for (float weight : particle_weights) if (weight > 0.0f) weight_total_ += weight;
    if (weights_->size() != root_states.size()) weight_total_ = 0.0f;
    const State& seed_state = root_states.front();
    player_count_ = state_player_count(seed_state, 0);
    node_count_ = 1;
    Node root;
    root.player = root_player;
    root.actions = game_.legal_actions(seed_state, root_player);
    if (root.actions.empty()) return {};
    expand(root, seed_state);
    for (int offset = 0; offset < config_.simulations; offset += batch_size) {
      const int count = std::min(batch_size, config_.simulations - offset);
      std::vector<State> states;
      std::vector<int> players;
      std::vector<std::vector<Action>> actions;
      std::vector<std::vector<Node*>> paths;
      std::vector<std::array<float, kValueSlots>> terminal_values;
      std::vector<bool> terminal;
      for (int i = 0; i < count; ++i) {
        // 每条模拟重新抽一个粒子：世界只在本次模拟内有效
        State state = root_states[pick_particle()];
        Node* node = &root;
        std::vector<Node*> path{&root};
        bool collected = false;
        for (int depth = 0; depth < config_.max_depth; ++depth) {
          if (game_.terminal(state)) {
            terminal.push_back(true); terminal_values.push_back(game_.terminal_value_vector(state, node->player));
            paths.push_back(std::move(path)); collected = true; break;
          }
          if (!node->expanded) {
            terminal.push_back(false); terminal_values.push_back({});
            states.push_back(std::move(state)); players.push_back(node->player);
            actions.push_back(node->actions); paths.push_back(std::move(path));
            collected = true; break;
          }
          const size_t index = select(*node);
          if (index >= node->actions.size() ||
              !game_.apply(state, node->player, node->actions[index])) {
            terminal.push_back(true); terminal_values.push_back(node->value_vector);
            paths.push_back(std::move(path)); collected = true; break;
          }
          if (!node->children[index]) {
            if (node_count_ >= static_cast<size_t>(std::max(1, config_.max_nodes))) {
              terminal.push_back(true); terminal_values.push_back(node->value_vector);
              paths.push_back(std::move(path)); collected = true; break;
            }
            node->children[index] = std::make_unique<Node>();
            ++node_count_;
            node->children[index]->player = game_.next_player(state);
            node->children[index]->actions = game_.legal_actions(state, node->children[index]->player);
          }
          node = node->children[index].get();
          path.push_back(node);
        }
        if (!collected) {
          terminal.push_back(true); terminal_values.push_back(node->value_vector);
          paths.push_back(std::move(path));
        }
        // 批量收集叶节点期间先加临时访问次数，让同一 batch 内的后续
        // simulation 能看到前面路径，避免所有叶节点都挤在同一条根分支。
        // 真正 backup 前会撤销这些 virtual visits，再写入真实统计量。
        for (Node* visited : paths.back()) ++visited->visits;
      }
      for (const auto& path : paths)
        for (Node* visited : path) --visited->visits;
      std::vector<Evaluation> evaluations;
      if (!states.empty()) evaluations = evaluator_.evaluate_batch(states, players, actions);
      size_t eval_index = 0;
      for (size_t i = 0; i < paths.size(); ++i) {
        std::array<float, kValueSlots> value = terminal_values[i];
        if (!terminal[i] && eval_index < evaluations.size()) {
          value = evaluations[eval_index].has_value_vector
              ? evaluations[eval_index].value_vector : std::array<float, kValueSlots>{};
          if (!evaluations[eval_index].has_value_vector) value[0] = evaluations[eval_index].value;
          expand(*paths[i].back(), states[eval_index], evaluations[eval_index]);
          ++eval_index;
        }
        backup(paths[i], value);
      }
    }
    return result(root);
  }

 private:
  struct Node {
    int player = 0; std::vector<Action> actions; std::vector<float> priors;
    std::vector<std::unique_ptr<Node>> children;
    std::array<float, kValueSlots> total{};
    std::array<float, kValueSlots> value_vector{};
    float value = 0;
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
    node.value_vector = evaluation.has_value_vector ? evaluation.value_vector : std::array<float, kValueSlots>{};
    if (!evaluation.has_value_vector) node.value_vector[0] = evaluation.value;
    node.value = node.value_vector[0]; node.children.resize(node.actions.size()); node.expanded = true;
  }
  size_t select(const Node& node) const {
    size_t best = 0; float score_best = -std::numeric_limits<float>::infinity();
    const float parent = static_cast<float>(std::max(1, node.visits));
    for (size_t i = 0; i < node.actions.size(); ++i) {
      const Node* child = node.children[i].get();
      const float visits = child ? static_cast<float>(child->visits) : 0.0f;
      const size_t slot = child && player_count_ ? relative_slot(child->player, node.player) : 0;
      const float q = child && child->visits ? child->total[slot] / child->visits : 0.0f;
      const float p = i < node.priors.size() ? node.priors[i] : 0.0f;
      const float score = q + config_.c_puct * p * std::sqrt(parent) / (1.0f + visits);
      if (score > score_best) { score_best = score; best = i; }
    }
    return best;
  }
  size_t relative_slot(int perspective, int target) const {
    if (!player_count_) return 0;
    return (static_cast<size_t>((target - perspective + static_cast<int>(player_count_)) %
                                static_cast<int>(player_count_))) % kValueSlots;
  }
  void backup(const std::vector<Node*>& path,
              const std::array<float, kValueSlots>& value) {
    const int leaf_player = path.back()->player;
    for (Node* node : path) {
      if (!player_count_) node->total[0] += value[0] * (node->player == leaf_player ? 1.0f : -1.0f);
      else for (size_t rel = 0; rel < kValueSlots && rel < player_count_; ++rel) {
        const int target = (node->player + static_cast<int>(rel)) % static_cast<int>(player_count_);
        node->total[rel] += value[relative_slot(leaf_player, target)];
      }
      ++node->visits;
    }
  }
  Result result(const Node& root) const {
    Result output; output.policy.resize(root.actions.size(), 0.0f);
    for (size_t i = 0; i < root.children.size(); ++i) if (root.children[i]) {
      output.policy[i] = static_cast<float>(root.children[i]->visits); output.visits += root.children[i]->visits;
    }
    if (output.visits) for (float& value : output.policy) value /= output.visits;
    else output.policy = root.priors;
    if (root.visits) for (size_t i = 0; i < kValueSlots; ++i) output.value_vector[i] = root.total[i] / root.visits;
    else output.value_vector = root.value_vector;
    output.value = output.value_vector[0];
    return output;
  }
  // 按权重抽一个粒子；权重缺失 / 全 0 / 长度对不上时退化为均匀采样
  size_t pick_particle() {
    const size_t n = roots_ ? roots_->size() : 0;
    if (n <= 1) return 0;
    if (weight_total_ > 0.0f) {
      std::uniform_real_distribution<float> dist(0.0f, weight_total_);
      float remaining = dist(rng_);
      for (size_t i = 0; i < n; ++i) {
        remaining -= (*weights_)[i] > 0.0f ? (*weights_)[i] : 0.0f;
        if (remaining <= 0.0f) return i;
      }
      return n - 1;
    }
    std::uniform_int_distribution<size_t> dist(0, n - 1);
    return dist(rng_);
  }
  const GameAdapter<State, Action>& game_; BatchedEvaluator<State, Action>& evaluator_; Config config_;
  std::mt19937 rng_{config_.seed};
  const std::vector<State>* roots_ = nullptr;
  const std::vector<float>* weights_ = nullptr;
  float weight_total_ = 0.0f;
  size_t player_count_ = 0;
  size_t node_count_ = 0;
};

}  // namespace citadels::native
