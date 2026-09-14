#include <iostream>

#include "batch_evaluator.hpp"

using namespace citadels::native;

int main() {
  BatchEvaluator evaluator(uniform_batch_backend());
  const std::vector<BatchEvaluationRequest> requests = {
      {{1.0f, 2.0f}, {{1.0f}, {2.0f}, {3.0f}}},
      {{4.0f, 5.0f}, {{1.0f}, {2.0f}}}
  };
  const auto result = evaluator.evaluate(requests);
  std::cout << result.policies.size() << ',' << result.policies[0].size() << ','
            << result.policies[1].size() << ',' << result.policies[0][0] << ','
            << result.values.size();
  return 0;
}
