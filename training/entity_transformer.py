"""Entity Transformer v6 model and flat-weight bridge."""

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
CITY_CARD_FEATURES = 54
CITY_EMBEDDING_DIM = 8
ENTITY_V6_CITY_SLOTS = 16
ENTITY_V6_CITY_SLOT_SIZE = 8
ENTITY_V6_PLAYER_FEATURE_SIZE = 56 + ENTITY_V6_CITY_SLOTS * ENTITY_V6_CITY_SLOT_SIZE
ENTITY_V6_PLAYER_EMBED_FEATURE_SIZE = 56 + ENTITY_V6_CITY_SLOTS * (7 + CITY_EMBEDDING_DIM)
ENTITY_V6_BASE_SIZE = 32 + 8 * ENTITY_V6_PLAYER_FEATURE_SIZE + CITY_CARD_FEATURES
ENTITY_V6_CONTEXT_FEATURES = 496
ENTITY_V6_STATE_SIZE = ENTITY_V6_BASE_SIZE + ENTITY_V6_CONTEXT_FEATURES
ACTION_SIZE = 448
INSTANCE_FEATURE_SLICE = slice(182, 244)


def migrate_action_encoding(model, optimizer, source_version):
    """Warm-start v9 weights in v10 without altering their initial logits."""
    if source_version == 10:
        return False
    if source_version != 9:
        raise ValueError(f"unsupported action encoding migration: {source_version}")
    parameter = model.action_embed.weight
    with torch.no_grad():
        parameter[:, INSTANCE_FEATURE_SLICE].zero_()
        for value in optimizer.state.get(parameter, {}).values():
            if isinstance(value, torch.Tensor) and value.shape == parameter.shape:
                value[:, INSTANCE_FEATURE_SLICE].zero_()
    return True


def migrate_model_weights(source, target, source_action_version, target_action_version):
    """Copy parameters by meaning; preserve legacy outputs on expanded inputs."""
    source_pair = (source.encoding_version, source_action_version)
    target_pair = (target.encoding_version, target_action_version)
    supported = {(14, 9), (14, 10), (15, 11)}
    if source_pair not in supported or target_pair not in supported:
        raise ValueError("unsupported model encoding pair")
    if source.profile != target.profile or source.architecture != target.architecture:
        raise ValueError("weight migration requires matching architecture/profile")
    if source_pair != target_pair and not (source_pair == (14, 9) and target_pair == (14, 10) or
                                         source.encoding_version == 14 and target_pair == (15, 11)):
        raise ValueError("encoding downgrade is not supported")
    old = dict(source.named_parameters())
    expanded = source.encoding_version == 14 and target.encoding_version == 15
    special = {"global_embed.weight", "global_embed.bias", "city_embed.weight",
               "self_embed.weight", "action_embed.weight"} if expanded else set()
    with torch.no_grad():
        for name, parameter in target.named_parameters():
            if name not in special:
                if parameter.shape != old[name].shape:
                    raise ValueError(f"unmapped parameter shape: {name}")
                parameter.copy_(old[name])
        if expanded:
            target.global_embed.weight.zero_()
            target.global_embed.weight[:, :source.global_embed.in_features].copy_(source.global_embed.weight)
            # State header changes from 14 to 15. Offset its constant contribution.
            target.global_embed.bias.copy_(source.global_embed.bias - source.global_embed.weight[:, 0])
            target.city_embed.weight.zero_()
            target.city_embed.weight[:source.card_features + 1].copy_(source.city_embed.weight)
            target.self_embed.weight.zero_()
            target.self_embed.weight[:, :source.self_embed.in_features].copy_(source.self_embed.weight)
            target.action_embed.weight.zero_()
            target.action_embed.weight[:, :source.action_size].copy_(source.action_embed.weight)
        if source_action_version == 9 and target_action_version != 9:
            # v9 did not train any suffix feature, including district effects.
            target.action_embed.weight[:, 182:].zero_()


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
    def __init__(self, profile="balanced", state_size=None, action_size=None,
                 architecture="entity-v6", encoding_version=15):
        super().__init__()
        if architecture != "entity-v6":
            raise ValueError("only entity-v6 is supported")
        self.player_feature_size = ENTITY_V6_PLAYER_FEATURE_SIZE
        if encoding_version not in (14, 15):
            raise ValueError("unsupported entity state encoding version")
        self.encoding_version = encoding_version
        self.card_features = CITY_CARD_FEATURES if encoding_version == 15 else 30
        self.context_features = ENTITY_V6_CONTEXT_FEATURES if encoding_version == 15 else 256
        self.base_size = 32 + 8 * self.player_feature_size + self.card_features
        self.state_size = self.base_size + self.context_features
        expected_action_size = ACTION_SIZE if encoding_version == 15 else 256
        if action_size is None:
            action_size = expected_action_size
        if state_size is not None and state_size != self.state_size or action_size != expected_action_size:
            raise ValueError("entity transformer state/action width mismatch")
        self.architecture = architecture
        model_dim, heads, layers, ff_dim, action_hidden = ENTITY_PROFILES[profile]
        self.profile = profile
        self.action_size = action_size
        self.model_dim = model_dim
        self.global_embed = nn.Linear(32 + self.context_features, model_dim)
        self.city_embed = nn.Embedding(self.card_features + 1, CITY_EMBEDDING_DIM, padding_idx=0)
        player_embed_size = ENTITY_V6_PLAYER_EMBED_FEATURE_SIZE
        self.player_embed = nn.Linear(player_embed_size, model_dim)
        self.self_embed = nn.Linear(player_embed_size + self.card_features, model_dim)
        self.action_embed = nn.Linear(action_size, model_dim)
        self.blocks = nn.ModuleList([
            EntityTransformerBlock(model_dim, heads, ff_dim) for _ in range(layers)
        ])
        self.action1 = nn.Linear(model_dim * 2, action_hidden)
        self.action_out = nn.Linear(action_hidden, 1)
        self.value_out = nn.Linear(model_dim, 1)
        positional = torch.zeros(9, model_dim, dtype=torch.float32)
        for position in range(9):
            for index in range(model_dim):
                pair = index // 2
                angle = position / (10000 ** ((2 * pair) / model_dim))
                positional[position, index] = math.sin(angle) if index % 2 == 0 else math.cos(angle)
        self.register_buffer("position_encoding", positional)
        # Keep this list in exact parity with the C++ flat-weight bridge.
        self.ordered = [self.global_embed]
        self.ordered.append(self.city_embed)
        self.ordered.append(self.player_embed)
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
        global_features = torch.cat((states[..., :32], states[..., self.base_size:]), dim=-1)
        global_token = self.global_embed(global_features).unsqueeze(1)
        player_end = 32 + 8 * self.player_feature_size
        players = states[..., 32:player_end].reshape(*states.shape[:-1], 8, self.player_feature_size)
        city = players[..., 56:].reshape(*states.shape[:-1], 8, ENTITY_V6_CITY_SLOTS, ENTITY_V6_CITY_SLOT_SIZE)
        city_ids = city[..., 3].to(torch.long).clamp(0, self.card_features)
        city_embeddings = self.city_embed(city_ids).flatten(start_dim=-2)
        city_props = city[..., :3].flatten(start_dim=-2)
        extra_props = city[..., 4:8].flatten(start_dim=-2)
        players = torch.cat((players[..., :56], city_props, extra_props, city_embeddings), dim=-1)
        player_tokens = self.player_embed(players)
        self_token_input = torch.cat((players[..., 0, :], states[..., player_end:self.base_size]), dim=-1)
        self_token = self.self_embed(self_token_input).unsqueeze(-2)
        player_tokens = torch.cat((self_token, player_tokens[..., 1:, :]), dim=-2)
        tokens = torch.cat((global_token, player_tokens), dim=1)
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

