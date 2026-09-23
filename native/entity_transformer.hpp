#pragma once

#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include <torch/torch.h>

namespace citadels::native {

// C++/LibTorch mirror of training/entity_transformer.py and
// training/entity-transformer-policy.js.  The parameter order is:
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
  EntityTransformerNetImpl(int model_dim, int heads, int layers, int ff_dim, int action_hidden)
      : model_dim_(model_dim), heads_(heads),
        global_embed(register_module("global_embed", torch::nn::Linear(32, model_dim))),
        player_embed(register_module("player_embed", torch::nn::Linear(80, model_dim))),
        action_embed(register_module("action_embed", torch::nn::Linear(256, model_dim))),
        action1(register_module("action1", torch::nn::Linear(model_dim * 2, action_hidden))),
        action_out(register_module("action_out", torch::nn::Linear(action_hidden, 1))),
        value_out(register_module("value_out", torch::nn::Linear(model_dim, 1))) {
    for (int i = 0; i < layers; ++i) {
      auto block = EntityTransformerBlock(model_dim, heads, ff_dim);
      blocks.push_back(block);
      register_module("block" + std::to_string(i), block);
    }
  }

  std::tuple<torch::Tensor, torch::Tensor> forward(
      const torch::Tensor& states, const torch::Tensor& actions,
      const torch::Tensor& mask) {
    auto global = global_embed->forward(states.slice(-1, 0, 32)).unsqueeze(1);
    auto players = states.slice(-1, 32, 672).view({states.size(0), 8, 80});
    auto tokens = torch::cat({global, player_embed->forward(players)}, 1);
    for (auto& block : blocks) tokens = block->forward(tokens);
    auto context = tokens.slice(1, 0, 1).expand({-1, actions.size(1), -1});
    auto action_tokens = action_embed->forward(actions);
    auto logits = action_out->forward(torch::elu(action1->forward(torch::cat({context, action_tokens}, -1)))).squeeze(-1);
    logits = logits.masked_fill(mask.logical_not(), -1e9);
    auto values = value_out->forward(tokens.slice(1, 1, 9)).squeeze(-1);
    return {logits, values};
  }

  int model_dim_, heads_;
  torch::nn::Linear global_embed{nullptr}, player_embed{nullptr}, action_embed{nullptr};
  std::vector<EntityTransformerBlock> blocks;
  torch::nn::Linear action1{nullptr}, action_out{nullptr}, value_out{nullptr};
};
TORCH_MODULE(EntityTransformerNet);

}  // namespace citadels::native
