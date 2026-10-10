#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <fstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <torch/torch.h>

#include "neural_evaluator.hpp"
#include "entity_transformer.hpp"

namespace citadels::native {

#ifdef _WIN32
inline bool libtorch_cuda_runtime_loaded() {
  static HMODULE cuda_module = LoadLibraryW(L"torch_cuda.dll");
  return cuda_module != nullptr;
}
#endif

class DirectNeuralEvaluator : public BatchedEvaluator<NativeGameState, NativeSearchAction> {
 public:
  virtual ~DirectNeuralEvaluator() = default;
  virtual const std::string& device_name() const = 0;
  virtual void reload_model(const std::string& model_path) = 0;
};

class LibTorchEntityTransformerEvaluator final : public DirectNeuralEvaluator {
 public:
  LibTorchEntityTransformerEvaluator(std::string profile, std::string model_path, std::string device,
                                     bool positional_encoding = true,
                                     int action_encoding_version = kActionEncodingVersion)
      : device_name_(std::move(device)), action_encoding_version_(action_encoding_version) {
    const int state_version = state_version_for_action(action_encoding_version_);
    if (profile == "fast") model_ = EntityTransformerNet(128, 4, 2, 256, 128, positional_encoding, state_version);
    else if (profile == "large") model_ = EntityTransformerNet(256, 4, 3, 512, 256, positional_encoding, state_version);
    else model_ = EntityTransformerNet(192, 4, 3, 384, 192, positional_encoding, state_version);
    if (device_name_ == "cuda") {
      bool available = false;
      try {
#ifdef _WIN32
        available = libtorch_cuda_runtime_loaded();
#else
        available = true;
#endif
        available = available && torch::cuda::is_available();
      } catch (...) { available = false; }
      if (!available) { device_name_ = "cpu"; device_ = torch::Device(torch::kCPU); }
      else device_ = torch::Device(torch::kCUDA);
    } else device_ = torch::Device(torch::kCPU);
    model_->to(device_);
    reload_model(model_path);
  }
  const std::string& device_name() const override { return device_name_; }
  Evaluation evaluate(const NativeGameState& state, int player,
                      const std::vector<NativeSearchAction>& actions) override {
    auto all = evaluate_batch({state}, {player}, {actions});
    return all.empty() ? Evaluation{} : all.front();
  }
  std::vector<Evaluation> evaluate_batch(const std::vector<NativeGameState>& states,
      const std::vector<int>& players, const std::vector<std::vector<NativeSearchAction>>& actions) override {
    if (states.empty() || states.size() != actions.size()) return {};
    size_t maximum = 1;
    for (const auto& group : actions) maximum = std::max(maximum, group.size());
    std::vector<float> flat_states, flat_actions;
    std::vector<uint8_t> flat_mask(states.size() * maximum, 0);
    const size_t state_size = state_feature_size(state_version_for_action(action_encoding_version_));
    const size_t action_size = action_feature_size(action_encoding_version_);
    flat_states.reserve(states.size() * state_size); flat_actions.assign(states.size() * maximum * action_size, 0.0f);
    for (size_t i = 0; i < states.size(); ++i) {
      auto encoded = encode_network_state(states[i], i < players.size() ? players[i] : -1,
        state_version_for_action(action_encoding_version_));
      if (encoded.size() != state_size) throw std::runtime_error("Entity Transformer 状态特征维度错误");
      flat_states.insert(flat_states.end(), encoded.begin(), encoded.end());
      for (size_t j = 0; j < actions[i].size(); ++j) {
        auto a = encode_network_action(actions[i][j], &states[i],
          i < players.size() ? players[i] : -1, action_encoding_version_);
        std::copy(a.begin(), a.end(), flat_actions.begin() + (i * maximum + j) * action_size);
        flat_mask[i * maximum + j] = 1;
      }
    }
    auto opts = torch::TensorOptions().dtype(torch::kFloat32);
    auto state_tensor = torch::from_blob(flat_states.data(), {static_cast<int64_t>(states.size()), static_cast<int64_t>(state_size)}, opts).clone().to(device_);
    auto action_tensor = torch::from_blob(flat_actions.data(), {static_cast<int64_t>(states.size()), static_cast<int64_t>(maximum), static_cast<int64_t>(action_size)}, opts).clone().to(device_);
    auto mask_tensor = torch::from_blob(flat_mask.data(), {static_cast<int64_t>(states.size()), static_cast<int64_t>(maximum)}, torch::TensorOptions().dtype(torch::kBool)).clone().to(device_);
    torch::InferenceMode guard;
    auto outputs = model_->forward(state_tensor, action_tensor, mask_tensor);
    auto probabilities = torch::softmax(std::get<0>(outputs), -1).to(torch::kCPU).contiguous();
    auto values = std::get<1>(outputs).to(torch::kCPU).contiguous();
    const float* p = probabilities.data_ptr<float>(); const float* v = values.data_ptr<float>();
    std::vector<Evaluation> result; result.reserve(states.size());
    for (size_t i = 0; i < states.size(); ++i) {
      Evaluation e; e.priors.assign(p + i * maximum, p + i * maximum + actions[i].size());
      for (size_t slot = 0; slot < kValueSlots; ++slot) e.value_vector[slot] = v[i * kValueSlots + slot];
      e.value = e.value_vector[0]; e.has_value_vector = true; result.push_back(std::move(e));
    }
    return result;
  }

  std::pair<std::vector<float>, std::vector<float>> forward_encoded(
      const std::vector<float>& state_features,
      const std::vector<std::vector<float>>& action_features) {
    const size_t expected_state_size = state_feature_size(state_version_for_action(action_encoding_version_));
    const size_t action_size = action_feature_size(action_encoding_version_);
    if (state_features.size() != expected_state_size || action_features.empty())
      throw std::runtime_error("forward_probe 输入的状态宽度或动作数量无效");
    for (const auto& action : action_features)
      if (action.size() != action_size) throw std::runtime_error("forward_probe 动作特征宽度不匹配");
    auto options = torch::TensorOptions().dtype(torch::kFloat32);
    auto state_tensor = torch::from_blob(const_cast<float*>(state_features.data()),
      {1, static_cast<int64_t>(expected_state_size)}, options).clone().to(device_);
    std::vector<float> flat_actions;
    flat_actions.reserve(action_features.size() * action_size);
    for (const auto& action : action_features) flat_actions.insert(flat_actions.end(), action.begin(), action.end());
    auto action_tensor = torch::from_blob(flat_actions.data(),
      {1, static_cast<int64_t>(action_features.size()), static_cast<int64_t>(action_size)}, options).clone().to(device_);
    auto mask_tensor = torch::ones({1, static_cast<int64_t>(action_features.size())},
      torch::TensorOptions().dtype(torch::kBool)).to(device_);
    torch::InferenceMode guard;
    auto outputs = model_->forward(state_tensor, action_tensor, mask_tensor);
    auto logits = std::get<0>(outputs).to(torch::kCPU).contiguous();
    auto values = std::get<1>(outputs).to(torch::kCPU).contiguous();
    const float* logits_data = logits.data_ptr<float>();
    const float* values_data = values.data_ptr<float>();
    return {{logits_data, logits_data + action_features.size()},
            {values_data, values_data + kValueSlots}};
  }

  void reload_model(const std::string& model_path) override {
    std::ifstream input(model_path, std::ios::binary); if (!input) throw std::runtime_error("无法读取 LibTorch 模型: " + model_path);
    input.seekg(0, std::ios::end); const auto bytes = input.tellg(); input.seekg(0, std::ios::beg);
    if (bytes <= 0 || bytes % static_cast<std::streamoff>(sizeof(float)) != 0) throw std::runtime_error("Entity Transformer 权重文件无效");
    std::vector<float> flat(static_cast<size_t>(bytes) / sizeof(float)); input.read(reinterpret_cast<char*>(flat.data()), bytes);
    size_t total = 0;
    auto count_linear = [&](const torch::nn::Linear& layer) { total += layer->weight.numel() + layer->bias.numel(); };
    auto count_norm = [&](const torch::nn::LayerNorm& layer) { total += layer->weight.numel() + layer->bias.numel(); };
    count_linear(model_->global_embed);
    total += model_->city_embed->weight.numel();
    count_linear(model_->player_embed);
    count_linear(model_->self_embed);
    count_linear(model_->action_embed);
    for (const auto& block : model_->blocks) {
      count_linear(block->q); count_linear(block->k); count_linear(block->v); count_linear(block->attn_out);
      count_linear(block->ff1); count_linear(block->ff2); count_norm(block->norm1); count_norm(block->norm2);
    }
    count_linear(model_->action1); count_linear(model_->action_out); count_linear(model_->value_out);
    if (flat.size() != total) throw std::runtime_error("Entity Transformer 参数数量不匹配");
    size_t offset = 0; torch::NoGradGuard guard;
    auto copy_parameter = [&](torch::Tensor parameter) {
      const size_t count = parameter.numel();
      auto tensor = torch::from_blob(flat.data() + offset, {static_cast<int64_t>(count)}, torch::TensorOptions().dtype(torch::kFloat32));
      parameter.copy_(tensor.view_as(parameter)); offset += count;
    };
    auto copy_linear = [&](const torch::nn::Linear& layer) { copy_parameter(layer->weight); copy_parameter(layer->bias); };
    auto copy_norm = [&](const torch::nn::LayerNorm& layer) { copy_parameter(layer->weight); copy_parameter(layer->bias); };
    copy_linear(model_->global_embed);
    copy_parameter(model_->city_embed->weight);
    copy_linear(model_->player_embed);
    copy_linear(model_->self_embed);
    copy_linear(model_->action_embed);
    for (const auto& block : model_->blocks) {
      copy_linear(block->q); copy_linear(block->k); copy_linear(block->v); copy_linear(block->attn_out);
      copy_linear(block->ff1); copy_linear(block->ff2); copy_norm(block->norm1); copy_norm(block->norm2);
    }
    copy_linear(model_->action1); copy_linear(model_->action_out); copy_linear(model_->value_out);
    model_->to(device_); model_->eval();
  }
 private:
  std::string device_name_; torch::Device device_{torch::kCPU}; EntityTransformerNet model_{nullptr};
  int action_encoding_version_;
};

}  // namespace citadels::native
