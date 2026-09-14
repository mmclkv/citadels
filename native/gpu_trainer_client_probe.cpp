#include <iostream>

#include "gpu_trainer_client.hpp"

using namespace citadels::native;

int main() {
  const std::vector<std::vector<float>> states = {{1.0f, 2.0f}, {3.0f, 4.0f}};
  const std::vector<std::vector<std::vector<float>>> actions = {
      {{1.0f}, {2.0f}}, {{3.0f}}
  };
  const auto request = encode_batch_eval_request(states, actions, "large");
  const auto result = decode_batch_eval_response(
      "{\"ok\":true,\"probsList\":[[0.25,0.75],[1]],\"values\":[0.5,-0.25]}", {2, 1});
  std::cout << (request.find("batch_eval") != std::string::npos) << ','
            << result.policies.size() << ',' << result.policies[0][1] << ','
            << result.values[1];
  return 0;
}
