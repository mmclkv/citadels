#pragma once

#include <cstddef>
#include <array>
#include <functional>
#include <vector>

namespace citadels::native {

struct BatchEvaluationRequest {
  std::vector<float> state;
  std::vector<std::vector<float>> actions;
};

struct BatchEvaluationResult {
  std::vector<std::vector<float>> policies;
  std::vector<float> values;
  std::vector<std::array<float, 8>> value_vectors;
};

using BatchInferenceBackend = std::function<BatchEvaluationResult(
    const std::vector<std::vector<float>>&, 
    const std::vector<std::vector<std::vector<float>>>&)>;

// MCTS worker 与网络后端之间的批量边界。后端可以是 CUDA、CPU 或进程桥，
// 只需遵守每个请求的动作组长度，padding 和设备管理由后端自行处理。
class BatchEvaluator {
 public:
  explicit BatchEvaluator(BatchInferenceBackend backend) : backend_(std::move(backend)) {}

  BatchEvaluationResult evaluate(const std::vector<BatchEvaluationRequest>& requests) const {
    std::vector<std::vector<float>> states;
    std::vector<std::vector<std::vector<float>>> actions;
    states.reserve(requests.size());
    actions.reserve(requests.size());
    for (const auto& request : requests) {
      states.push_back(request.state);
      actions.push_back(request.actions);
    }
    auto result = backend_(states, actions);
    const bool has_vectors = result.value_vectors.size() == requests.size();
    const bool has_scalars = result.values.size() == requests.size();
    if (result.policies.size() != requests.size() || (!has_vectors && !has_scalars))
      return {};
    for (size_t i = 0; i < requests.size(); ++i) {
      if (result.policies[i].size() != requests[i].actions.size()) return {};
    }
    return result;
  }

 private:
  BatchInferenceBackend backend_;
};

inline BatchInferenceBackend uniform_batch_backend() {
  return [](const auto&, const auto& action_groups) {
    BatchEvaluationResult result;
    for (const auto& group : action_groups) {
      result.policies.emplace_back(group.size(), group.empty() ? 0.0f
                                                               : 1.0f / group.size());
      result.values.push_back(0.0f);
      result.value_vectors.push_back({});
    }
    return result;
  };
}

}  // namespace citadels::native
