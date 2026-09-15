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

namespace citadels::native {

#ifdef _WIN32
inline void ensure_libtorch_cuda_loaded() {
  static HMODULE cuda_module = LoadLibraryW(L"torch_cuda.dll");
  if (!cuda_module) throw std::runtime_error("无法加载 LibTorch torch_cuda.dll");
}
#endif

struct LibTorchPolicyValueNetImpl : torch::nn::Module {
  LibTorchPolicyValueNetImpl(int state_size, int action_size,
                             int state_hidden, int latent,
                             int policy_hidden, int policy_mid, int value_hidden)
      : state1(register_module("state1", torch::nn::Linear(state_size, state_hidden))),
        state2(register_module("state2", torch::nn::Linear(state_hidden, latent))),
        policy1(register_module("policy1", torch::nn::Linear(latent + action_size, policy_hidden))),
        policy2(register_module("policy2", torch::nn::Linear(policy_hidden, policy_mid))),
        policy_out(register_module("policy_out", torch::nn::Linear(policy_mid, 1))),
        value1(register_module("value1", torch::nn::Linear(latent, value_hidden))),
        value_out(register_module("value_out", torch::nn::Linear(value_hidden, kValueSlots))) {}

  std::tuple<torch::Tensor, torch::Tensor> forward(
      const torch::Tensor& states, const torch::Tensor& actions,
      const torch::Tensor& mask) {
    auto latent = torch::elu(state1->forward(states));
    latent = torch::elu(state2->forward(latent));
    auto values = value_out->forward(torch::elu(value1->forward(latent)));
    auto expanded = latent.unsqueeze(1).expand({-1, actions.size(1), -1});
    auto policy = torch::cat({expanded, actions}, -1);
    policy = torch::elu(policy1->forward(policy));
    policy = torch::elu(policy2->forward(policy));
    auto logits = policy_out->forward(policy).squeeze(-1);
    logits = logits.masked_fill(mask.logical_not(), -1e9);
    return {logits, values};
  }

  torch::nn::Linear state1{nullptr}, state2{nullptr};
  torch::nn::Linear policy1{nullptr}, policy2{nullptr}, policy_out{nullptr};
  torch::nn::Linear value1{nullptr}, value_out{nullptr};
};

TORCH_MODULE(LibTorchPolicyValueNet);

class LibTorchNeuralBatchedEvaluator final
    : public BatchedEvaluator<NativeGameState, NativeSearchAction> {
 public:
  LibTorchNeuralBatchedEvaluator(std::string profile, std::string model_path,
                                 std::string device)
      : profile_(std::move(profile)), device_name_(std::move(device)) {
    const auto dims = profile_dimensions(profile_);
  model_ = LibTorchPolicyValueNet(512, 256, dims[0], dims[1], dims[2], dims[3], dims[4]);
    if (device_name_ == "cuda") {
#ifdef _WIN32
      ensure_libtorch_cuda_loaded();
#endif
      if (!torch::cuda::is_available()) throw std::runtime_error("LibTorch CUDA 不可用");
      device_ = torch::Device(torch::kCUDA);
    } else {
      device_ = torch::Device(torch::kCPU);
    }
    model_->to(device_);
    reload_model(model_path);
  }

  Evaluation evaluate(const NativeGameState& state, int player,
                      const std::vector<NativeSearchAction>& actions) override {
    auto result = evaluate_batch({state}, {player}, {actions});
    return result.empty() ? Evaluation{} : result.front();
  }

  std::vector<Evaluation> evaluate_batch(
      const std::vector<NativeGameState>& states, const std::vector<int>& players,
      const std::vector<std::vector<NativeSearchAction>>& actions) override {
    if (states.empty() || states.size() != actions.size()) return {};
    constexpr size_t state_size = 512;
    constexpr size_t action_size = 256;
    const size_t batch = states.size();
    size_t maximum = 1;
    std::vector<std::vector<float>> state_vectors;
    state_vectors.reserve(batch);
    for (size_t i = 0; i < states.size(); ++i)
      state_vectors.push_back(encode_network_state(states[i], i < players.size() ? players[i] : -1));
    for (const auto& vector : state_vectors)
      if (vector.size() != state_size) throw std::runtime_error("LibTorch 状态特征维度错误");
    for (const auto& group : actions) maximum = std::max(maximum, group.size());

    std::vector<float> flat_states(batch * state_size, 0.0f);
    for (size_t i = 0; i < batch; ++i)
      std::copy(state_vectors[i].begin(), state_vectors[i].end(), flat_states.begin() + i * state_size);
    std::vector<float> flat_actions(batch * maximum * action_size, 0.0f);
    std::vector<uint8_t> flat_mask(batch * maximum, 0);
    for (size_t i = 0; i < batch; ++i) {
      for (size_t j = 0; j < actions[i].size(); ++j) {
        const auto encoded = encode_network_action(actions[i][j]);
        std::copy(encoded.begin(), encoded.end(),
                  flat_actions.begin() + (i * maximum + j) * action_size);
        flat_mask[i * maximum + j] = 1;
      }
    }
    auto float_options = torch::TensorOptions().dtype(torch::kFloat32);
    auto bool_options = torch::TensorOptions().dtype(torch::kBool);
    auto state_tensor = torch::from_blob(flat_states.data(),
      {static_cast<int64_t>(batch), static_cast<int64_t>(state_size)}, float_options).clone().to(device_);
    auto action_tensor = torch::from_blob(flat_actions.data(),
      {static_cast<int64_t>(batch), static_cast<int64_t>(maximum), static_cast<int64_t>(action_size)},
      float_options).clone().to(device_);
    auto mask_tensor = torch::from_blob(flat_mask.data(),
      {static_cast<int64_t>(batch), static_cast<int64_t>(maximum)}, bool_options).clone().to(device_);

    torch::InferenceMode guard;
    auto outputs = model_->forward(state_tensor, action_tensor, mask_tensor);
    auto probabilities = torch::softmax(std::get<0>(outputs), -1).to(torch::kCPU).contiguous();
    auto values = std::get<1>(outputs).to(torch::kCPU).contiguous();
    const float* probability_data = probabilities.data_ptr<float>();
    const float* value_data = values.data_ptr<float>();
    std::vector<Evaluation> result;
    result.reserve(batch);
    for (size_t i = 0; i < batch; ++i) {
      Evaluation evaluation;
      evaluation.priors.assign(probability_data + i * maximum,
                               probability_data + i * maximum + actions[i].size());
      for (size_t slot = 0; slot < kValueSlots; ++slot)
        evaluation.value_vector[slot] = value_data[i * kValueSlots + slot];
      evaluation.value = evaluation.value_vector[0];
      evaluation.has_value_vector = true;
      result.push_back(std::move(evaluation));
    }
    return result;
  }

  void reload_model(const std::string& model_path) {
    std::ifstream input(model_path, std::ios::binary);
    if (!input) throw std::runtime_error("无法读取 LibTorch 模型: " + model_path);
    input.seekg(0, std::ios::end);
    const auto byte_count = input.tellg();
    input.seekg(0, std::ios::beg);
    if (byte_count <= 0 || byte_count % static_cast<std::streamoff>(sizeof(float)) != 0)
      throw std::runtime_error("LibTorch 模型文件长度不是 float32 的整数倍");
    std::vector<float> flat(static_cast<size_t>(byte_count) / sizeof(float));
    input.read(reinterpret_cast<char*>(flat.data()), byte_count);
    if (!input) throw std::runtime_error("读取 LibTorch 模型失败: " + model_path);
    auto tensor = torch::from_blob(flat.data(), {static_cast<int64_t>(flat.size())},
                                   torch::TensorOptions().dtype(torch::kFloat32));
    torch::NoGradGuard guard;
    size_t expected = 0;
    for (const auto& layer : {model_->state1, model_->state2, model_->policy1,
                              model_->policy2, model_->policy_out, model_->value1,
                              model_->value_out})
      expected += layer->weight.numel() + layer->bias.numel();
    const size_t legacy_value_head_size = model_->value_out->options.in_features() * (kValueSlots - 1) +
                                           (kValueSlots - 1);
    const bool legacy = flat.size() == expected - legacy_value_head_size;
    if (!legacy && flat.size() != expected)
      throw std::runtime_error("LibTorch 模型参数数量不匹配");
    size_t offset = 0;
    auto copy_layer = [&](torch::nn::Linear& layer) {
      const size_t weight_count = layer->weight.numel();
      const size_t bias_count = layer->bias.numel();
      if (offset + weight_count + bias_count > flat.size())
        throw std::runtime_error("LibTorch 模型参数数量不足");
      layer->weight.copy_(tensor.slice(0, static_cast<int64_t>(offset),
                                       static_cast<int64_t>(offset + weight_count)).view_as(layer->weight));
      offset += weight_count;
      layer->bias.copy_(tensor.slice(0, static_cast<int64_t>(offset),
                                     static_cast<int64_t>(offset + bias_count)).view_as(layer->bias));
      offset += bias_count;
    };
    copy_layer(model_->state1); copy_layer(model_->state2);
    copy_layer(model_->policy1); copy_layer(model_->policy2); copy_layer(model_->policy_out);
    copy_layer(model_->value1);
    if (legacy) {
      model_->value_out->weight.zero_(); model_->value_out->bias.zero_();
      const size_t old_weight_count = model_->value_out->options.in_features();
      model_->value_out->weight[0].copy_(tensor.slice(0, static_cast<int64_t>(offset),
          static_cast<int64_t>(offset + old_weight_count)));
      offset += old_weight_count;
      model_->value_out->bias[0].copy_(tensor[offset]);
      offset += 1;
    } else copy_layer(model_->value_out);
    if (offset != flat.size()) throw std::runtime_error("LibTorch 模型参数数量不匹配");
    model_->to(device_);
    model_->eval();
  }

 private:
  static std::array<int, 5> profile_dimensions(const std::string& profile) {
    if (profile == "fast") return {256, 128, 128, 64, 64};
    if (profile == "large") return {512, 384, 384, 192, 192};
    return {384, 256, 256, 128, 128};
  }

  std::string profile_, device_name_;
  torch::Device device_{torch::kCPU};
  LibTorchPolicyValueNet model_{nullptr};
};

}  // namespace citadels::native
