#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace citadels::native {

constexpr size_t kValueSlots = 8;

// Compact information-set identity. The old implementation formatted a large
// observable state/action description into a string at every tree level.
struct InformationSetKey {
  uint64_t lo = 0;
  uint64_t hi = 0;
  bool operator==(const InformationSetKey& other) const {
    return lo == other.lo && hi == other.hi;
  }
};

struct InformationSetKeyHasher {
  size_t operator()(const InformationSetKey& key) const {
    return static_cast<size_t>(key.lo ^ (key.hi + 0x9e3779b97f4a7c15ULL +
                                         (key.lo << 6) + (key.lo >> 2)));
  }
};

class InformationSetKeyBuilder {
 public:
  void bytes(const void* data, size_t size) {
    const auto* input = static_cast<const uint8_t*>(data);
    for (size_t i = 0; i < size; ++i) {
      lo_ ^= input[i]; lo_ *= 1099511628211ULL;
      hi_ ^= static_cast<uint64_t>(input[i]) + 0x9d;
      hi_ *= 14029467366897019727ULL;
      hi_ ^= hi_ >> 29;
    }
  }
  void u64(uint64_t value) { bytes(&value, sizeof(value)); }
  void i32(int value) { const auto v = static_cast<int64_t>(value); bytes(&v, sizeof(v)); }
  void boolean(bool value) { const uint8_t v = value ? 1 : 0; bytes(&v, sizeof(v)); }
  void floating(float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    u64(bits);
  }
  void string(const std::string& value) {
    u64(value.size());
    bytes(value.data(), value.size());
  }
  InformationSetKey finish() const { return {lo_, hi_}; }

 private:
  uint64_t lo_ = 1469598103934665603ULL;
  uint64_t hi_ = 1099511628211ULL;
};

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
  // 兼容旧适配器的字符串接口；新的搜索核心优先使用紧凑 hash。
  virtual std::string information_set_key(const State&, int) const { return {}; }
  virtual InformationSetKey information_set_hash(const State& state, int player) const {
    const std::string key = information_set_key(state, player);
    if (key.empty()) return {};
    InformationSetKeyBuilder builder;
    builder.string(key);
    return builder.finish();
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
inline void add_root_noise(std::vector<float>& priors, std::mt19937& rng, float alpha, float epsilon) {
  if (priors.size() < 2 || alpha <= 0.0f || epsilon <= 0.0f) return;
  std::gamma_distribution<float> gamma(alpha, 1.0f);
  std::vector<float> noise(priors.size());
  float total = 0.0f;
  for (float& value : noise) { value = gamma(rng); total += value; }
  if (total <= 0.0f) return;
  const float mix = std::min(1.0f, epsilon);
  for (size_t i = 0; i < priors.size(); ++i)
    priors[i] = (1.0f - mix) * priors[i] + mix * noise[i] / total;
}

template <typename State, typename Action>
class Mcts {
 private:
  struct Node {
    int player = 0;
    std::vector<Action> actions;
    std::vector<float> priors;
    std::vector<std::vector<std::unique_ptr<Node>>> child_variants;
    std::vector<std::unordered_map<InformationSetKey, Node*, InformationSetKeyHasher>> child_by_key;
    InformationSetKey information_set_key;
    std::array<float, kValueSlots> total{};
    std::array<float, kValueSlots> value_vector{};
    float value = 0.0f;
    int visits = 0;
    bool expanded = false;
  };

 public:
  // Owns search statistics only, never an authoritative state or particles.
  // Advancement follows an observed action AND information-set identity.
  class Tree {
    friend class Mcts;
   public:
    void clear() { root_.reset(); }
    bool empty() const { return !root_; }
    bool matches(InformationSetKey key,int player) const {
      return root_ && root_->player==player && root_->information_set_key==key;
    }
    size_t nodes() const { return count(root_.get()); }
    bool advance(size_t action,InformationSetKey key,int player) {
      if(!root_ || action>=root_->child_variants.size()){clear();return false;}
      std::unique_ptr<Node> next;
      for(auto& child:root_->child_variants[action])
        if(child->player==player && child->information_set_key==key){next=std::move(child);break;}
      root_=std::move(next);return static_cast<bool>(root_);
    }
   private:
    static size_t count(const Node* n) {
      if(!n)return 0;size_t total=1;
      for(const auto& edge:n->child_variants)for(const auto& child:edge)total+=count(child.get());
      return total;
    }
    std::unique_ptr<Node> root_;
  };
  struct Config {
    int simulations = 50;
    int max_depth = 400;
    float c_puct = 1.0f;
    float dirichlet_alpha = 0.3f;
    float dirichlet_epsilon = 0.0f;
    uint32_t seed = 1;
    // Zero preserves fixed-budget training. Checked between simulations;
    // an individual evaluation/application is not forcibly interrupted.
    int time_budget_ms = 0;
  };

  struct Result {
    std::vector<float> policy;
    float value = 0.0f;
    std::array<float, kValueSlots> value_vector{};
    int visits = 0;
    int expansions = 0;
    int new_visits = 0;
    int reused_visits = 0;
    size_t retained_nodes = 0;
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
                const std::vector<float>& particle_weights = {},Tree* retained_tree = nullptr) {
    if (root_states.empty()) return {};
    roots_ = &root_states;
    weights_ = &particle_weights;
    weight_total_ = 0.0f;
    for (float weight : particle_weights) if (weight > 0.0f) weight_total_ += weight;
    if (weights_->size() != root_states.size()) weight_total_ = 0.0f;
    expansions_ = 0;
    const State& seed_state = root_states.front();
    player_count_ = state_player_count(seed_state, 0);
    Tree local_tree;
    Tree& tree=retained_tree?*retained_tree:local_tree;
    const auto root_key=retained_tree?game_.information_set_hash(seed_state,root_player):InformationSetKey{};
    if(root_key==InformationSetKey{} || !tree.matches(root_key,root_player))tree.clear();
    if(!tree.root_)tree.root_=std::make_unique<Node>();
    Node& root=*tree.root_;
    const int inherited=root.visits;
    const auto deadline = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(std::max(0,config_.time_budget_ms));
    root.player = root_player;
    root.information_set_key=root_key;
    root.actions = game_.legal_actions(seed_state, root_player);
    if (root.actions.empty()) return {};
    expand(root, seed_state);
    if(!inherited)add_root_noise(root.priors, rng_, config_.dirichlet_alpha, config_.dirichlet_epsilon);

    for (int i = 0; i < config_.simulations; ++i) {
      if (i > 0 && config_.time_budget_ms > 0 && std::chrono::steady_clock::now() >= deadline) break;
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
        // Terminal states have no next actor. Keep the mover as the value
        // perspective so terminal rewards are not collapsed to an all-zero vector.
        const int player = game_.terminal(state) ? node->player : game_.next_player(state);
        const InformationSetKey key = game_.information_set_hash(state, player);
        Node* child = find_child(*node, index, key);
        if (!child) {
          auto fresh = std::make_unique<Node>();
          child = fresh.get();
          node->child_variants[index].push_back(std::move(fresh));
          child->player = player;
          child->information_set_key = key;
          child->actions = game_.legal_actions(state, player);
          node->child_by_key[index].emplace(key, child);
        }
        node = child;
        path.push_back(node);
      }
      if (!backed_up) {
        if (game_.terminal(state)) backup(path, game_.terminal_value_vector(state, node->player));
        else {
          // A final move can create a leaf exactly at the depth boundary.
          // Its default zero vector is not a network evaluation.
          if (!node->expanded) expand(*node, state);
          backup(path, node->value_vector);
        }
      }
    }

    Result result;
    result.new_visits=root.visits-inherited;
    result.reused_visits=inherited;
    if(retained_tree)result.retained_nodes=tree.nodes();
    result.policy.resize(root.actions.size(), 0.0f);
    for (size_t i = 0; i < root.child_variants.size(); ++i) {
      for (const auto& child : root.child_variants[i]) {
        result.policy[i] += static_cast<float>(child->visits);
        result.visits += child->visits;
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
    node.child_variants.resize(node.actions.size());
    node.child_by_key.resize(node.actions.size());
    node.expanded = true;
    ++expansions_;
  }

  size_t select(const Node& node) {
    size_t best = 0;
    float best_score = -std::numeric_limits<float>::infinity();
    const float parent = static_cast<float>(std::max(1, node.visits));
    const float fpu = node.visits ? node.total[0] / node.visits : node.value_vector[0];
    for (size_t i = 0; i < node.actions.size(); ++i) {
      const auto& variants = node.child_variants[i];
      float visits = 0.0f, total = 0.0f;
      for (const auto& child : variants) {
        visits += static_cast<float>(child->visits);
        const size_t slot = player_count_ ? relative_slot(child->player, node.player) : 0;
        total += child->visits ? child->total[slot] : 0.0f;
      }
      const float q = visits > 0.0f ? total / visits : fpu;
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

  Node* find_child(Node& node, size_t action, const InformationSetKey& key) {
    if (action >= node.child_variants.size()) return nullptr;
    const auto& index = node.child_by_key[action];
    const auto it = index.find(key);
    return it == index.end() ? nullptr : it->second;
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

  const GameAdapter<State, Action>& game_;
  Evaluator<State, Action>& evaluator_;
  Config config_;
  std::mt19937 rng_;
  const std::vector<State>* roots_ = nullptr;
  const std::vector<float>* weights_ = nullptr;
  float weight_total_ = 0.0f;
  int expansions_ = 0;
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
              BatchedEvaluator<State, Action>& evaluator, Config config = {},
              std::function<int(const State&, int, int, const std::vector<Action>&)> npc_choice = {})
      : game_(game), evaluator_(evaluator), config_(config), npc_choice_(std::move(npc_choice)) {}

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
    root_player_ = root_player;
    expansions_ = 0;
    Node root;
    root.player = root_player;
    root.actions = game_.legal_actions(seed_state, root_player);
    if (root.actions.empty()) return {};
    expand(root, seed_state);
    add_root_noise(root.priors, rng_, config_.dirichlet_alpha, config_.dirichlet_epsilon);
    int completed = 0;
    while (completed < config_.simulations) {
      const int count = std::min(batch_size, config_.simulations - completed);
      std::vector<State> states;
      std::vector<int> players;
      std::vector<std::vector<Action>> actions;
      std::vector<std::vector<Node*>> paths;
      std::vector<std::array<float, kValueSlots>> terminal_values;
      std::vector<bool> terminal;
      std::vector<size_t> path_evaluation_indices;
      std::unordered_map<Node*, size_t> pending_evaluations;
      for (int i = 0; i < count; ++i) {
        // 每条模拟重新抽一个粒子：世界只在本次模拟内有效
        State state = root_states[pick_particle()];
        Node* node = &root;
        std::vector<Node*> path{&root};
        bool collected = false;
        bool pending_collision = false;
        for (int depth = 0; depth < config_.max_depth; ++depth) {
          if (game_.terminal(state)) {
            terminal.push_back(true); terminal_values.push_back(game_.terminal_value_vector(state, node->player));
            paths.push_back(std::move(path));
            path_evaluation_indices.push_back(std::numeric_limits<size_t>::max());
            collected = true; break;
          }
          if (!node->expanded) {
            if (pending_evaluations.find(node) != pending_evaluations.end()) {
              // This attempt has no new evidence. Flush the existing batch
              // so the next selection can descend through the expanded leaf.
              // It receives neither a reservation nor a simulation credit.
              pending_collision = true;
              break;
            }
            terminal.push_back(false); terminal_values.push_back({});
            paths.push_back(std::move(path));
            const auto [pending, inserted] = pending_evaluations.emplace(node, states.size());
            if (inserted) {
              states.push_back(std::move(state)); players.push_back(node->player);
              actions.push_back(node->actions);
            }
            path_evaluation_indices.push_back(pending->second);
            collected = true; break;
          }
          const size_t index = select(*node);
          if (index >= node->actions.size() ||
              !game_.apply(state, node->player, node->actions[index])) {
            terminal.push_back(true); terminal_values.push_back(node->value_vector);
            paths.push_back(std::move(path));
            path_evaluation_indices.push_back(std::numeric_limits<size_t>::max());
            collected = true; break;
          }
          const int player = game_.terminal(state) ? node->player : game_.next_player(state);
          const InformationSetKey key = game_.information_set_hash(state, player);
          Node* child = find_child(*node, index, key);
          if (!child) {
            auto fresh = std::make_unique<Node>();
            child = fresh.get();
            node->child_variants[index].push_back(std::move(fresh));
            child->player = player;
            child->information_set_key = key;
            child->actions = search_actions(state, player);
            node->child_by_key[index].emplace(key, child);
          }
          node = child;
          path.push_back(node);
        }
        if (pending_collision) break;
        if (!collected) {
          if (!game_.terminal(state) && !node->expanded) {
            if (pending_evaluations.find(node) != pending_evaluations.end()) break;
            const size_t eval_index = states.size();
            pending_evaluations.emplace(node, eval_index);
            states.push_back(std::move(state)); players.push_back(node->player);
            actions.push_back(node->actions);
            terminal.push_back(false); terminal_values.push_back({});
            path_evaluation_indices.push_back(eval_index);
          } else {
            // Known network values and terminal outcomes can be backed up
            // immediately; a fresh truncated leaf must join the GPU batch.
            terminal.push_back(true);
            terminal_values.push_back(game_.terminal(state)
              ? game_.terminal_value_vector(state, node->player) : node->value_vector);
            path_evaluation_indices.push_back(std::numeric_limits<size_t>::max());
          }
          paths.push_back(std::move(path));
        }
        // Completed results need no GPU evaluation: expose them immediately
        // to subsequent selections, even within this batch.
        if (terminal.back()) backup(paths.back(), terminal_values.back());
        else for (Node* visited : paths.back()) ++visited->pending_visits;
      }
      for (size_t i = 0; i < paths.size(); ++i)
        if (!terminal[i])
          for (Node* visited : paths[i]) --visited->pending_visits;
      const std::vector<Evaluation> evaluations = states.empty()
          ? std::vector<Evaluation>{} : evaluator_.evaluate_batch(states, players, actions);
      if (evaluations.size() != states.size())
        throw std::runtime_error("MCTS evaluator returned an incomplete leaf batch");
      for (const auto& [node, eval_index] : pending_evaluations)
        if (eval_index < evaluations.size()) expand(*node, states[eval_index], evaluations[eval_index]);
      for (size_t i = 0; i < paths.size(); ++i) {
        if (terminal[i]) continue;  // Already backed up during collection.
        std::array<float, kValueSlots> value = terminal_values[i];
        const size_t eval_index = path_evaluation_indices[i];
        if (!terminal[i] && eval_index < evaluations.size()) {
          value = evaluations[eval_index].has_value_vector
              ? evaluations[eval_index].value_vector : std::array<float, kValueSlots>{};
          if (!evaluations[eval_index].has_value_vector) value[0] = evaluations[eval_index].value;
        }
        backup(paths[i], value);
      }
      completed += static_cast<int>(paths.size());
    }
    return result(root);
  }

 private:
  struct Node {
    int player = 0; std::vector<Action> actions; std::vector<float> priors;
    std::vector<std::vector<std::unique_ptr<Node>>> child_variants;
    std::vector<std::unordered_map<InformationSetKey, Node*, InformationSetKeyHasher>> child_by_key;
    InformationSetKey information_set_key;
    std::array<float, kValueSlots> total{};
    std::array<float, kValueSlots> value_vector{};
    float value = 0;
    int visits = 0;
    int pending_visits = 0;
    bool expanded = false;
  };
  void expand(Node& node, const State& state) {
    auto evaluation = evaluator_.evaluate(state, node.player, node.actions);
    expand(node, state, evaluation);
  }
  void expand(Node& node, const State&, const Evaluation& evaluation) {
    if (!node.expanded) ++expansions_;
    node.priors = evaluation.priors;
    if (node.priors.size() != node.actions.size())
      node.priors.assign(node.actions.size(), 1.0f / node.actions.size());
    node.value_vector = evaluation.has_value_vector ? evaluation.value_vector : std::array<float, kValueSlots>{};
    if (!evaluation.has_value_vector) node.value_vector[0] = evaluation.value;
    node.value = node.value_vector[0];
    node.child_variants.resize(node.actions.size());
    node.child_by_key.resize(node.actions.size());
    node.expanded = true;
  }
  size_t select(const Node& node) const {
    size_t best = 0; float score_best = -std::numeric_limits<float>::infinity();
    const float parent = static_cast<float>(std::max(1, node.visits + node.pending_visits));
    // Slot zero always belongs to this node's actor, not the root actor.
    // Reservations are not evidence and must not enter this mean.
    const float fpu = node.visits ? node.total[0] / node.visits : node.value_vector[0];
    for (size_t i = 0; i < node.actions.size(); ++i) {
      const auto& variants = node.child_variants[i];
      float visits = 0.0f, pending = 0.0f, total = 0.0f;
      for (const auto& child : variants) {
        visits += static_cast<float>(child->visits);
        pending += static_cast<float>(child->pending_visits);
        const size_t slot = player_count_ ? relative_slot(child->player, node.player) : 0;
        total += child->visits ? child->total[slot] : 0.0f;
      }
      const float q = visits > 0.0f ? total / visits : fpu;
      const float p = i < node.priors.size() ? node.priors[i] : 0.0f;
      // Reservations spread work through U only. W/N remains the observed
      // mean, so negative values cannot improve merely by reserving a path.
      const float score = q + config_.c_puct * p * std::sqrt(parent) / (1.0f + visits + pending);
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
  std::vector<Action> search_actions(const State& state, int player) const {
    auto actions = game_.legal_actions(state, player);
    if (npc_choice_ && player != root_player_ && !actions.empty()) {
      const int selected = npc_choice_(state, player, root_player_, actions);
      if (selected >= 0 && static_cast<size_t>(selected) < actions.size())
        return {actions[static_cast<size_t>(selected)]};
    }
    return actions;
  }
  Result result(const Node& root) const {
    Result output; output.policy.resize(root.actions.size(), 0.0f);
    for (size_t i = 0; i < root.child_variants.size(); ++i)
      for (const auto& child : root.child_variants[i]) {
        output.policy[i] += static_cast<float>(child->visits);
        output.visits += child->visits;
      }
    if (output.visits) for (float& value : output.policy) value /= output.visits;
    else output.policy = root.priors;
    if (root.visits) for (size_t i = 0; i < kValueSlots; ++i) output.value_vector[i] = root.total[i] / root.visits;
    else output.value_vector = root.value_vector;
    output.value = output.value_vector[0];
    output.expansions = expansions_;
    return output;
  }
  Node* find_child(Node& node, size_t action, const InformationSetKey& key) {
    if (action >= node.child_variants.size()) return nullptr;
    const auto& index = node.child_by_key[action];
    const auto it = index.find(key);
    return it == index.end() ? nullptr : it->second;
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
  int root_player_ = 0;
  int expansions_ = 0;
  std::function<int(const State&, int, int, const std::vector<Action>&)> npc_choice_;
};

}  // namespace citadels::native
