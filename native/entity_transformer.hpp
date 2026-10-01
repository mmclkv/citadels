#pragma once

#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include <torch/torch.h>

#include "state_features.hpp"

namespace citadels::native {

// Archived C++/LibTorch implementation corresponding to
// training/entity_transformer.py. The parameter order is:
// embeddings, each block's q/k/v/attnOut/ff1/ff2/norm1/norm2,
// action1/actionOut/valueOut.
struct EntityTransformerBlockImpl : torch::nn::Module {
  EntityTransformerBlockImpl(int dim, int heads, int ff_dim)
      : dim_(dim), heads_(heads), head_dim_(dim / heads),
        q(register_module("q", torch::nn::Linear(dim, dim))),
        k(register_module("k", torch::nn::Linear(dim, dim))),
        v(register_module("v", torch::nn::Linear(dim, dim))),
        attn_out(register_module("attn_out", torch::nn::Linear(dim, dim))),
        ff1(register_module("ff1", torch::nn::Linear(dim, ff_dim))),
        ff2(register_module("ff2", torch::nn::Linear(ff_dim, dim))),
        norm1(register_module("norm1", torch::nn::LayerNorm(torch::nn::LayerNormOptions({dim})))),
        norm2(register_module("norm2", torch::nn::LayerNorm(torch::nn::LayerNormOptions({dim})))) {}

  torch::Tensor forward(const torch::Tensor& tokens) {
    const auto sizes = tokens.sizes();
    const auto batch = sizes[0];
    const auto count = sizes[1];
    auto query = q->forward(tokens).view({batch, count, heads_, head_dim_}).transpose(1, 2);
    auto key = k->forward(tokens).view({batch, count, heads_, head_dim_}).transpose(1, 2);
    auto value = v->forward(tokens).view({batch, count, heads_, head_dim_}).transpose(1, 2);
    auto scores = torch::matmul(query, key.transpose(-2, -1)) / std::sqrt(static_cast<float>(head_dim_));
    auto attention = torch::softmax(scores, -1);
    auto attended = torch::matmul(attention, value).transpose(1, 2).contiguous()
      .view({batch, count, dim_});
    auto first = norm1->forward(tokens + attn_out->forward(attended));
    return norm2->forward(first + ff2->forward(torch::elu(ff1->forward(first))));
  }

  int dim_, heads_, head_dim_;
  torch::nn::Linear q{nullptr}, k{nullptr}, v{nullptr}, attn_out{nullptr};
  torch::nn::Linear ff1{nullptr}, ff2{nullptr};
  torch::nn::LayerNorm norm1{nullptr}, norm2{nullptr};
};
TORCH_MODULE(EntityTransformerBlock);

struct EntityTransformerNetImpl : torch::nn::Module {
  EntityTransformerNetImpl(int model_dim, int heads, int layers, int ff_dim, int action_hidden,
                          bool positional_encoding = true, bool own_hand_features = false,
                          bool city_identity_features = false, bool public_context_features = false)
      : model_dim_(model_dim), heads_(heads), positional_encoding_(positional_encoding),
        own_hand_features_(own_hand_features),
        city_identity_features_(city_identity_features), public_context_features_(public_context_features),
        global_embed(register_module("global_embed", torch::nn::Linear(public_context_features ? 32 + kPublicContextFeatureSize : 32, model_dim))),
        player_embed(register_module("player_embed", torch::nn::Linear(city_identity_features ? kEntityV4PlayerEmbedFeatureSize : 80, model_dim))),
        self_embed(nullptr),
        city_embed(nullptr),
        action_embed(register_module("action_embed", torch::nn::Linear(256, model_dim))),
        action1(register_module("action1", torch::nn::Linear(model_dim * 2, action_hidden))),
        action_out(register_module("action_out", torch::nn::Linear(action_hidden, 1))),
        value_out(register_module("value_out", torch::nn::Linear(model_dim, 1))) {
    if (own_hand_features_) self_embed = register_module("self_embed", torch::nn::Linear(city_identity_features_ ? kEntityV4PlayerEmbedFeatureSize + 30 : 110, model_dim));
    if (city_identity_features_) city_embed = register_module("city_embed",
      torch::nn::Embedding(torch::nn::EmbeddingOptions(kCityCardFeatureSize + 1, kCityCardEmbeddingSize).padding_idx(0)));
    for (int i = 0; i < layers; ++i) {
      auto block = EntityTransformerBlock(model_dim, heads, ff_dim);
      blocks.push_back(block);
      register_module("block" + std::to_string(i), block);
    }
  }

  std::tuple<torch::Tensor, torch::Tensor> forward(
      const torch::Tensor& states, const torch::Tensor& actions,
      const torch::Tensor& mask) {
    auto global_features = public_context_features_
      ? torch::cat({states.slice(-1, 0, 32), states.slice(-1, kEntityV4StateFeatureSize, kEntityV5StateFeatureSize)}, -1)
      : states.slice(-1, 0, 32);
    auto global = global_embed->forward(global_features).unsqueeze(1);
    const int player_width = city_identity_features_ ? kEntityV4PlayerFeatureSize : 80;
    auto players = states.slice(-1, 32, 32 + 8 * player_width).view({states.size(0), 8, player_width});
    if (city_identity_features_) {
      auto city = players.slice(-1, 56, player_width).view({states.size(0), 8, 8, kCityIdSlotSize});
      auto ids = city.select(-1, 3).to(torch::kLong).clamp(0, kCityCardFeatureSize);
      auto ids_embed = city_embed->forward(ids).flatten(-2, -1);
      auto city_props = city.slice(-1, 0, 3).flatten(-2, -1);
      players = torch::cat({players.slice(-1, 0, 56), city_props, ids_embed}, -1);
    }
    auto player_tokens = player_embed->forward(players);
    if (own_hand_features_) {
      const int hand_start = 32 + 8 * player_width;
      auto self_features = torch::cat({players.select(1, 0), states.slice(-1, hand_start, hand_start + 30)}, -1);
      auto self_token = self_embed->forward(self_features).unsqueeze(1);
      player_tokens = torch::cat({self_token, player_tokens.slice(1, 1, 8)}, 1);
    }
    auto tokens = torch::cat({global, player_tokens}, 1);
    if (positional_encoding_) {
      std::vector<float> positions(9 * model_dim_);
      for (int position = 0; position < 9; ++position) {
        for (int index = 0; index < model_dim_; ++index) {
          const int pair = index / 2;
          const double angle = position / std::pow(10000.0, (2.0 * pair) / model_dim_);
          positions[position * model_dim_ + index] = static_cast<float>(
            index % 2 == 0 ? std::sin(angle) : std::cos(angle));
        }
      }
      auto positional = torch::from_blob(positions.data(), {1, 9, model_dim_},
        torch::TensorOptions().dtype(torch::kFloat32)).to(tokens.device());
      tokens = tokens + positional;
    }
    for (auto& block : blocks) tokens = block->forward(tokens);
    auto context = tokens.slice(1, 0, 1).expand({-1, actions.size(1), -1});
    auto action_tokens = action_embed->forward(actions);
    auto logits = action_out->forward(torch::elu(action1->forward(torch::cat({context, action_tokens}, -1)))).squeeze(-1);
    logits = logits.masked_fill(mask.logical_not(), -1e9);
    auto values = value_out->forward(tokens.slice(1, 1, 9)).squeeze(-1);
    return {logits, values};
  }

  int model_dim_, heads_;
  bool positional_encoding_, own_hand_features_;
  bool city_identity_features_;
  bool public_context_features_;
  torch::nn::Linear global_embed{nullptr}, player_embed{nullptr}, self_embed{nullptr};
  torch::nn::Embedding city_embed{nullptr};
  torch::nn::Linear action_embed{nullptr}, action1{nullptr}, action_out{nullptr}, value_out{nullptr};
  std::vector<EntityTransformerBlock> blocks;
};
TORCH_MODULE(EntityTransformerNet);

}  // namespace citadels::native
