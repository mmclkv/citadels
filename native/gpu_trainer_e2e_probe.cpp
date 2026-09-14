#include <iostream>

#include "gpu_trainer_client.hpp"

using namespace citadels::native;

int main(int argc, char** argv) {
  if (argc < 4) return 2;
  GpuTrainerClient client(argv[1], argv[2]);
  client.start("large", argv[3], 0.0003f, "cuda");
  std::vector<std::vector<float>> states(2, std::vector<float>(192, 0.0f));
  states[0][0] = 1.0f; states[1][1] = 0.5f;
  std::vector<std::vector<std::vector<float>>> actions(2);
  actions[0] = {std::vector<float>(64, 0.0f), std::vector<float>(64, 0.1f)};
  actions[1] = {std::vector<float>(64, 0.2f)};
  const auto result = client.evaluate(states, actions, "large");
  std::cout << result.policies.size() << ',' << result.policies[0].size() << ','
            << result.policies[1].size() << ',' << result.values.size() << ','
            << result.policies[0][0] << ',' << result.values[0] << '\n';
  client.close();
  return 0;
}
