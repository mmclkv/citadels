"""Entity Transformer v1.

This module mirrors training/entity-transformer-policy.js.  The state protocol
is intentionally unchanged: 32 global features followed by eight 80-feature
relative player slots.  The explicit ``ordered`` list is used by the existing
flat-weight bridge and must stay in the same order as the JS implementation.
"""

import array
import os

import torch
from torch import nn
from torch.nn import functional as F


ENTITY_PROFILES = {
    "fast": (128, 4, 2, 256, 128),
    "balanced": (192, 4, 3, 384, 192),
    "large": (256, 4, 3, 512, 256),
}
VALUE_SLOTS = 8
STATE_SIZE = 672
ACTION_SIZE = 256


class EntityTransformerBlock(nn.Module):
    def __init__(self, dim, heads, ff_dim):
        super().__init__()
        if dim % heads:
            raise ValueError("entity transformer model_dim must be divisible by heads")
        self.dim = dim
        self.heads = heads
        self.head_dim = dim // heads
        self.q = nn.Linear(dim, dim)
        self.k = nn.Linear(dim, dim)
        self.v = nn.Linear(dim, dim)
        self.attn_out = nn.Linear(dim, dim)
        self.ff1 = nn.Linear(dim, ff_dim)
        self.ff2 = nn.Linear(ff_dim, dim)
        self.norm1 = nn.LayerNorm(dim)
        self.norm2 = nn.LayerNorm(dim)

    def forward(self, tokens):
        # tokens: [batch, token_count, model_dim]
        batch, count, dim = tokens.shape
        q = self.q(tokens).view(batch, count, self.heads, self.head_dim).transpose(1, 2)
        k = self.k(tokens).view(batch, count, self.heads, self.head_dim).transpose(1, 2)
        v = self.v(tokens).view(batch, count, self.heads, self.head_dim).transpose(1, 2)
        scores = torch.matmul(q, k.transpose(-2, -1)) / (self.head_dim ** 0.5)
        attention = torch.softmax(scores, dim=-1)
        attended = torch.matmul(attention, v).transpose(1, 2).contiguous().view(batch, count, dim)
        x = self.norm1(tokens + self.attn_out(attended))
        return self.norm2(x + self.ff2(F.elu(self.ff1(x))))


class EntityTransformerNet(nn.Module):
    architecture = "entity-v1"

    def __init__(self, profile="balanced", state_size=STATE_SIZE, action_size=ACTION_SIZE):
        super().__init__()
        if state_size != STATE_SIZE or action_size != ACTION_SIZE:
            raise ValueError("entity-transformer-v1 requires state_size=672 and action_size=256")
        model_dim, heads, layers, ff_dim, action_hidden = ENTITY_PROFILES[profile]
        self.profile = profile
        self.state_size = state_size
        self.action_size = action_size
        self.model_dim = model_dim
        self.global_embed = nn.Linear(32, model_dim)
        self.player_embed = nn.Linear(80, model_dim)
        self.action_embed = nn.Linear(action_size, model_dim)
        self.blocks = nn.ModuleList([
            EntityTransformerBlock(model_dim, heads, ff_dim) for _ in range(layers)
        ])
        self.action1 = nn.Linear(model_dim * 2, action_hidden)
        self.action_out = nn.Linear(action_hidden, 1)
        self.value_out = nn.Linear(model_dim, 1)
        # Keep this list in exact parity with the JS flatten order.
        self.ordered = [self.global_embed, self.player_embed, self.action_embed]
        for block in self.blocks:
            self.ordered.extend([
                block.q, block.k, block.v, block.attn_out,
                block.ff1, block.ff2,
                block.norm1, block.norm2,
            ])
        self.ordered.extend([self.action1, self.action_out, self.value_out])

    def tokenize(self, states):
        if states.shape[-1] != STATE_SIZE:
            raise ValueError("entity transformer state width mismatch")
        global_token = self.global_embed(states[..., :32]).unsqueeze(1)
        players = states[..., 32:].reshape(*states.shape[:-1], 8, 80)
        player_tokens = self.player_embed(players)
        return torch.cat((global_token, player_tokens), dim=1)

    def forward(self, states, actions, mask=None, temperatures=None):
        tokens = self.tokenize(states)
        for block in self.blocks:
            tokens = block(tokens)
        global_token = tokens[:, :1, :]
        action_tokens = self.action_embed(actions)
        context = global_token.expand(-1, actions.shape[1], -1)
        policy = torch.cat((context, action_tokens), dim=-1)
        logits = self.action_out(F.elu(self.action1(policy))).squeeze(-1)
        if temperatures is not None:
            logits = logits / temperatures.unsqueeze(-1).clamp_min(0.15)
        if mask is not None:
            logits = logits.masked_fill(~mask, -1e9)
        values = self.value_out(tokens[:, 1:, :]).squeeze(-1)
        return logits, values

    def load_flat(self, filename):
        values = array.array("f")
        with open(filename, "rb") as handle:
            values.fromfile(handle, os.path.getsize(filename) // values.itemsize)
        expected = sum(layer.weight.numel() + layer.bias.numel() for layer in self.ordered)
        if len(values) != expected:
            raise ValueError(f"entity transformer parameter count mismatch: {len(values)} != {expected}")
        cursor = 0
        with torch.no_grad():
            for layer in self.ordered:
                weight_count = layer.weight.numel()
                layer.weight.copy_(torch.tensor(values[cursor:cursor + weight_count]).reshape_as(layer.weight))
                cursor += weight_count
                bias_count = layer.bias.numel()
                layer.bias.copy_(torch.tensor(values[cursor:cursor + bias_count]).reshape_as(layer.bias))
                cursor += bias_count
        if cursor != len(values):
            raise ValueError("entity transformer flat weight trailing data")

    def save_flat(self, filename):
        values = array.array("f")
        for layer in self.ordered:
            values.extend(layer.weight.detach().cpu().reshape(-1).tolist())
            values.extend(layer.bias.detach().cpu().reshape(-1).tolist())
        with open(filename, "wb") as handle:
            values.tofile(handle)

