"""Entity Transformer models.

Entity-v4 stores a
compact integer for each city building and maps it through a learned embedding
before player-token projection. The explicit ``ordered`` list is used by the
flat-weight bridge and must stay in the same order as the JS implementation.
"""

import array
import math
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
ENTITY_V3_STATE_SIZE = 702
CITY_CARD_FEATURES = 30
CITY_EMBEDDING_DIM = 8
CITY_ID_SLOT_SIZE = 4
PLAYER_FEATURE_SIZE = 56 + 8 * CITY_ID_SLOT_SIZE
PLAYER_EMBED_FEATURE_SIZE = 56 + 8 * (3 + CITY_EMBEDDING_DIM)
ENTITY_V4_STATE_SIZE = 32 + 8 * PLAYER_FEATURE_SIZE + CITY_CARD_FEATURES
PUBLIC_CONTEXT_FEATURES = 72
ENTITY_V5_STATE_SIZE = ENTITY_V4_STATE_SIZE + PUBLIC_CONTEXT_FEATURES
ENTITY_V6_CITY_SLOTS = 16
ENTITY_V6_CITY_SLOT_SIZE = 8
ENTITY_V6_PLAYER_FEATURE_SIZE = 56 + ENTITY_V6_CITY_SLOTS * ENTITY_V6_CITY_SLOT_SIZE
ENTITY_V6_PLAYER_EMBED_FEATURE_SIZE = 56 + ENTITY_V6_CITY_SLOTS * (7 + CITY_EMBEDDING_DIM)
ENTITY_V6_BASE_SIZE = 32 + 8 * ENTITY_V6_PLAYER_FEATURE_SIZE + CITY_CARD_FEATURES
ENTITY_V6_CONTEXT_FEATURES = 256
ENTITY_V6_STATE_SIZE = ENTITY_V6_BASE_SIZE + ENTITY_V6_CONTEXT_FEATURES
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

    def forward(self, tokens, key_padding_mask=None):
        # tokens: [batch, token_count, model_dim]
        batch, count, dim = tokens.shape
        q = self.q(tokens).view(batch, count, self.heads, self.head_dim).transpose(1, 2)
        k = self.k(tokens).view(batch, count, self.heads, self.head_dim).transpose(1, 2)
        v = self.v(tokens).view(batch, count, self.heads, self.head_dim).transpose(1, 2)
        scores = torch.matmul(q, k.transpose(-2, -1)) / (self.head_dim ** 0.5)
        if key_padding_mask is not None:
            scores = scores.masked_fill(~key_padding_mask[:, None, None, :], -1e9)
        attention = torch.softmax(scores, dim=-1)
        attended = torch.matmul(attention, v).transpose(1, 2).contiguous().view(batch, count, dim)
        x = self.norm1(tokens + self.attn_out(attended))
        return self.norm2(x + self.ff2(F.elu(self.ff1(x))))


class EntityTransformerNet(nn.Module):
    def __init__(self, profile="balanced", state_size=None, action_size=ACTION_SIZE,
                 architecture="entity-v5"):
        super().__init__()
        if architecture not in ("entity-v1", "entity-v2", "entity-v3", "entity-v4", "entity-v5", "entity-v6"):
            raise ValueError("unsupported entity transformer architecture: " + architecture)
        expects_hands = architecture in ("entity-v3", "entity-v4", "entity-v5", "entity-v6")
        expects_city_ids = architecture in ("entity-v4", "entity-v5", "entity-v6")
        expects_public_context = architecture in ("entity-v5", "entity-v6")
        expects_v6 = architecture == "entity-v6"
        self.player_feature_size = ENTITY_V6_PLAYER_FEATURE_SIZE if expects_v6 else PLAYER_FEATURE_SIZE if expects_city_ids else 80
        self.state_size = ENTITY_V6_STATE_SIZE if expects_v6 else ENTITY_V5_STATE_SIZE if expects_public_context else ENTITY_V4_STATE_SIZE if expects_city_ids else ENTITY_V3_STATE_SIZE if expects_hands else STATE_SIZE
        if state_size is not None and state_size != self.state_size or action_size != ACTION_SIZE:
            raise ValueError("entity transformer state/action width mismatch")
        self.architecture = architecture
        model_dim, heads, layers, ff_dim, action_hidden = ENTITY_PROFILES[profile]
        self.profile = profile
        self.action_size = action_size
        self.model_dim = model_dim
        self.global_embed = nn.Linear(32 + (ENTITY_V6_CONTEXT_FEATURES if expects_v6 else PUBLIC_CONTEXT_FEATURES) if expects_public_context else 32, model_dim)
        self.city_embed = nn.Embedding(CITY_CARD_FEATURES + 1, CITY_EMBEDDING_DIM, padding_idx=0) if expects_city_ids else None
        player_embed_size = ENTITY_V6_PLAYER_EMBED_FEATURE_SIZE if expects_v6 else PLAYER_EMBED_FEATURE_SIZE if expects_city_ids else self.player_feature_size
        self.player_embed = nn.Linear(player_embed_size, model_dim)
        self.self_embed = nn.Linear(player_embed_size + 30, model_dim) if expects_hands else None
        self.action_embed = nn.Linear(action_size, model_dim)
        self.blocks = nn.ModuleList([
            EntityTransformerBlock(model_dim, heads, ff_dim) for _ in range(layers)
        ])
        self.action1 = nn.Linear(model_dim * 2, action_hidden)
        self.action_out = nn.Linear(action_hidden, 1)
        self.value_out = nn.Linear(model_dim, 1)
        positional = torch.zeros(9, model_dim, dtype=torch.float32)
        if architecture in ("entity-v2", "entity-v3", "entity-v4", "entity-v5", "entity-v6"):
            for position in range(9):
                for index in range(model_dim):
                    pair = index // 2
                    angle = position / (10000 ** ((2 * pair) / model_dim))
                    positional[position, index] = math.sin(angle) if index % 2 == 0 else math.cos(angle)
        self.register_buffer("position_encoding", positional)
        # Keep this list in exact parity with the JS flatten order.
        self.ordered = [self.global_embed]
        if self.city_embed is not None:
            self.ordered.append(self.city_embed)
        self.ordered.append(self.player_embed)
        if self.self_embed is not None:
            self.ordered.append(self.self_embed)
        self.ordered.append(self.action_embed)
        for block in self.blocks:
            self.ordered.extend([
                block.q, block.k, block.v, block.attn_out,
                block.ff1, block.ff2,
                block.norm1, block.norm2,
            ])
        self.ordered.extend([self.action1, self.action_out, self.value_out])

    def tokenize(self, states):
        if states.shape[-1] != self.state_size:
            raise ValueError("entity transformer state width mismatch")
        if self.architecture == "entity-v6":
            global_features = torch.cat((states[..., :32], states[..., ENTITY_V6_BASE_SIZE:]), dim=-1)
        elif self.architecture == "entity-v5":
            global_features = torch.cat((states[..., :32], states[..., ENTITY_V4_STATE_SIZE:]), dim=-1)
        else:
            global_features = states[..., :32]
        global_token = self.global_embed(global_features).unsqueeze(1)
        player_end = 32 + 8 * self.player_feature_size
        players = states[..., 32:player_end].reshape(*states.shape[:-1], 8, self.player_feature_size)
        if self.city_embed is not None:
            slots = ENTITY_V6_CITY_SLOTS if self.architecture == "entity-v6" else 8
            slot_size = ENTITY_V6_CITY_SLOT_SIZE if self.architecture == "entity-v6" else CITY_ID_SLOT_SIZE
            city = players[..., 56:].reshape(*states.shape[:-1], 8, slots, slot_size)
            city_ids = city[..., 3].to(torch.long).clamp(0, CITY_CARD_FEATURES)
            city_embeddings = self.city_embed(city_ids).flatten(start_dim=-2)
            city_props = city[..., :3].flatten(start_dim=-2)
            if self.architecture == "entity-v6":
                extra_props = city[..., 4:8].flatten(start_dim=-2)
                players = torch.cat((players[..., :56], city_props, extra_props, city_embeddings), dim=-1)
            else:
                players = torch.cat((players[..., :56], city_props, city_embeddings), dim=-1)
        player_tokens = self.player_embed(players)
        if self.self_embed is not None:
            hand_end = ENTITY_V6_BASE_SIZE if self.architecture == "entity-v6" else ENTITY_V4_STATE_SIZE if self.architecture == "entity-v5" else self.state_size
            self_token_input = torch.cat((players[..., 0, :], states[..., player_end:hand_end]), dim=-1)
            self_token = self.self_embed(self_token_input).unsqueeze(-2)
            player_tokens = torch.cat((self_token, player_tokens[..., 1:, :]), dim=-2)
        tokens = torch.cat((global_token, player_tokens), dim=1)
        if self.architecture == "entity-v1":
            return tokens
        return tokens + self.position_encoding.unsqueeze(0)

    def forward(self, states, actions, mask=None, temperatures=None):
        tokens = self.tokenize(states)
        # Global token is always valid. Player rows are seat-relative and the
        # empty rows after player_count must not become attention keys.
        player_count = torch.round(states[..., 1] * 8).to(torch.long).clamp(1, 8)
        player_slots = torch.arange(8, device=states.device).unsqueeze(0)
        player_mask = player_slots < player_count.unsqueeze(-1)
        key_padding_mask = torch.cat((
            torch.ones((states.shape[0], 1), dtype=torch.bool, device=states.device),
            player_mask,
        ), dim=1)
        for block in self.blocks:
            tokens = block(tokens, key_padding_mask)
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
        expected = sum(layer.weight.numel() + (layer.bias.numel() if getattr(layer, "bias", None) is not None else 0)
                       for layer in self.ordered)
        if len(values) != expected:
            raise ValueError(f"entity transformer parameter count mismatch: {len(values)} != {expected}")
        cursor = 0
        with torch.no_grad():
            for layer in self.ordered:
                weight_count = layer.weight.numel()
                layer.weight.copy_(torch.tensor(values[cursor:cursor + weight_count]).reshape_as(layer.weight))
                cursor += weight_count
                if getattr(layer, "bias", None) is not None:
                    bias_count = layer.bias.numel()
                    layer.bias.copy_(torch.tensor(values[cursor:cursor + bias_count]).reshape_as(layer.bias))
                    cursor += bias_count
        if cursor != len(values):
            raise ValueError("entity transformer flat weight trailing data")

    def save_flat(self, filename):
        values = array.array("f")
        for layer in self.ordered:
            values.extend(layer.weight.detach().cpu().reshape(-1).tolist())
            if getattr(layer, "bias", None) is not None:
                values.extend(layer.bias.detach().cpu().reshape(-1).tolist())
        with open(filename, "wb") as handle:
            values.tofile(handle)

