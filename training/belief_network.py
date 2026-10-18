"""Independent history-conditioned joint role/hand-count belief model."""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
import torch
from torch import nn
from python_backend.belief_encoding import contract, PLAYER_SIZE, GLOBAL_SIZE, EVENT_SIZE, C, R, M


class BeliefNetwork(nn.Module):
    def __init__(self, dimension=128):
        super().__init__()
        self.dimension = dimension
        self.player = nn.Linear(PLAYER_SIZE, dimension)
        self.global_embed = nn.Linear(GLOBAL_SIZE, dimension)
        block = nn.TransformerEncoderLayer(dimension, 4, dimension*2, dropout=0., batch_first=True)
        self.entities = nn.TransformerEncoder(block, 2, enable_nested_tensor=False)
        self.history = nn.GRU(EVENT_SIZE, dimension, batch_first=True)
        self.fuse = nn.Sequential(nn.Linear(dimension*2, dimension), nn.Tanh())
        self.seat = nn.Embedding(8, dimension)
        self.role_embed = nn.Embedding(R, dimension)
        self.card_embed = nn.Embedding(C, dimension)
        self.count_embed = nn.Embedding(M+1, dimension)
        self.decoder = nn.GRUCell(dimension, dimension)
        self.role_head = nn.Linear(dimension, R)
        self.count_head = nn.Linear(dimension, M+1)

    def encode(self, observation, history):
        device = next(self.parameters()).device
        tensor = lambda value, dtype=torch.float32: torch.as_tensor(value, dtype=dtype, device=device)
        tokens = torch.cat((self.global_embed(tensor(observation['globalFeatures']))[None],
                            self.player(tensor(observation['players']))+self.seat.weight), 0)[None]
        padding = ~torch.cat((torch.ones(1, dtype=torch.bool, device=device),
                              tensor(observation['playerMask'], torch.bool)))
        current = self.entities(tokens, src_key_padding_mask=padding[None])[0, 0]
        if len(history):
            _, memory = self.history(tensor(history)[None])
            memory = memory[-1, 0]
        else:
            memory = torch.zeros_like(current)
        return self.fuse(torch.cat((current, memory)))

    def joint(self, observation, history, target=None, *, context=None, generator=None):
        """Exact teacher-forced joint log P, or constrained autoregressive draw.

        Same-player role slots are sorted, removing arbitrary label permutations.
        Counts conserve catalogue capacity and exact observed hand sizes.
        """
        h = self.encode(observation, history) if context is None else context
        device = h.device
        allowed = np.array(observation['roleAllowed'], copy=True)
        remaining = np.array(observation['remaining'], copy=True)
        role_terms, hand_terms, roles, hands = [], [], [], []
        previous_player, previous_role = -1, -1
        for slot, player in enumerate(observation['rolePlayers']):
            player = int(player)
            h = self.decoder(self.seat.weight[player], h)
            valid = allowed.copy()
            if player == previous_player:
                valid[:previous_role+1] = False
            # Leave enough greater IDs for remaining slots of this same hand.
            later = sum(int(p) == player for p in observation['rolePlayers'][slot+1:])
            if later:
                for r in range(R):
                    if np.count_nonzero(valid[r+1:]) < later:
                        valid[r] = False
            if not valid.any():
                raise ValueError('No legal hidden role assignment')
            logits = self.role_head(h).masked_fill(~torch.as_tensor(valid, device=device), -torch.inf)
            chosen = int(target['roles'][slot]) if target is not None else int(torch.multinomial(logits.softmax(-1), 1, generator=generator))
            if not valid[chosen]:
                raise ValueError('Hidden role target violates public constraints')
            role_terms.append(logits.log_softmax(-1)[chosen]);roles.append(chosen)
            allowed[chosen] = False
            h = self.decoder(self.role_embed.weight[chosen], h)
            previous_player, previous_role = player, chosen
        for zone, player in enumerate(observation['handPlayers']):
            h = self.decoder(self.seat.weight[int(player)], h)
            slots = int(observation['handSizes'][zone])
            hand = []
            for card in range(C):
                h = self.decoder(self.card_embed.weight[card], h)
                lower = max(0, slots-int(remaining[card+1:].sum()))
                upper = min(M, int(remaining[card]), slots)
                if lower > upper:
                    raise ValueError('No legal hidden hand assignment')
                valid = (torch.arange(M+1, device=device) >= lower) & (torch.arange(M+1, device=device) <= upper)
                logits = self.count_head(h).masked_fill(~valid, -torch.inf)
                chosen = int(target['hands'][zone, card]) if target is not None else int(torch.multinomial(logits.softmax(-1), 1, generator=generator))
                if not bool(valid[chosen]):
                    raise ValueError('Hidden card target violates public constraints')
                hand_terms.append(logits.log_softmax(-1)[chosen]);hand.append(chosen)
                slots -= chosen;remaining[card] -= chosen
                h = self.decoder(self.count_embed.weight[chosen], h)
            if slots:
                raise ValueError('Hidden hand size mismatch')
            hands.append(hand)
        zero = h.sum()*0
        role_logp = torch.stack(role_terms).sum() if role_terms else zero
        hand_logp = torch.stack(hand_terms).sum() if hand_terms else zero
        return dict(logProbability=role_logp+hand_logp, roleLogProbability=role_logp,
                    handLogProbability=hand_logp, roleDecisions=len(role_terms),
                    handDecisions=len(hand_terms), roles=np.array(roles),
                    hands=np.array(hands, dtype=np.int64).reshape(-1, C))

    def score_candidates(self, observation, history, targets):
        """Shared encoder and batched recurrent decoder for live particles."""
        device = next(self.parameters()).device
        size = len(targets)
        h = self.encode(observation, history)[None].expand(size, -1)
        role_targets = torch.as_tensor(np.stack([t['roles'] for t in targets]), device=device)
        hand_targets = torch.as_tensor(np.stack([t['hands'] for t in targets]), device=device)
        allowed = torch.as_tensor(observation['roleAllowed'], device=device)[None].expand(size, -1).clone()
        remaining = torch.as_tensor(observation['remaining'], device=device)[None].expand(size, -1).clone()
        logp = torch.zeros(size, device=device)
        ids = torch.arange(size, device=device)
        previous_player = -1
        previous_role = torch.zeros(size, device=device, dtype=torch.long)
        for slot, player in enumerate(observation['rolePlayers']):
            player = int(player)
            h = self.decoder(self.seat.weight[player].expand(size, -1), h)
            valid = allowed.clone()
            if player == previous_player:
                valid &= torch.arange(R, device=device)[None] > previous_role[:, None]
            later = sum(int(p) == player for p in observation['rolePlayers'][slot+1:])
            if later:
                greater = valid.flip(-1).cumsum(-1).flip(-1)-valid.long()
                valid &= greater >= later
            logits = self.role_head(h).masked_fill(~valid, -torch.inf)
            chosen = role_targets[:, slot]
            logp += logits.log_softmax(-1)[ids, chosen]
            allowed[ids, chosen] = False
            h = self.decoder(self.role_embed(chosen), h)
            previous_player, previous_role = player, chosen
        for zone, player in enumerate(observation['handPlayers']):
            h = self.decoder(self.seat.weight[int(player)].expand(size, -1), h)
            slots = torch.full((size,), int(observation['handSizes'][zone]), device=device)
            for card in range(C):
                h = self.decoder(self.card_embed.weight[card].expand(size, -1), h)
                lower = (slots-remaining[:, card+1:].sum(-1)).clamp_min(0)
                upper = torch.minimum(remaining[:, card], slots).clamp_max(M)
                values = torch.arange(M+1, device=device)[None]
                valid = (values >= lower[:, None]) & (values <= upper[:, None])
                logits = self.count_head(h).masked_fill(~valid, -torch.inf)
                chosen = hand_targets[:, zone, card]
                logp += logits.log_softmax(-1)[ids, chosen]
                remaining[:, card] -= chosen;slots -= chosen
                h = self.decoder(self.count_embed(chosen), h)
        return logp


def save_checkpoint(path, model, metadata, optimizer=None):
    """Non-pickle NPZ with a strict independent encoding contract, atomic replace."""
    import os
    path = Path(path);path.parent.mkdir(parents=True, exist_ok=True)
    values = {'weight:'+k: v.detach().cpu().numpy() for k, v in model.state_dict().items()}
    if optimizer is not None:
        for name, parameter in model.named_parameters():
            for key, value in optimizer.state.get(parameter, {}).items():
                if isinstance(value, torch.Tensor):
                    values['optimizer:'+name+':'+key] = value.detach().cpu().numpy()
    values['metadata'] = np.array(json.dumps(dict(metadata, architecture='belief-v1',
        dimension=model.dimension, contract=contract())))
    temporary = path.with_suffix('.tmp')
    with temporary.open('wb') as handle:
        np.savez_compressed(handle, **values)
    os.replace(temporary, path)


def load_checkpoint(path, device='cpu'):
    with np.load(path, allow_pickle=False) as data:
        metadata = json.loads(str(data['metadata']))
        if metadata.get('architecture') != 'belief-v1' or metadata.get('contract') != contract():
            raise ValueError('信念权重的架构、角色或建筑编码不匹配')
        dimension = metadata.get('dimension')
        if dimension not in (64, 128, 192):
            raise ValueError('信念网络规模不受支持')
        for key, default, low, high in (('historyLength', 128, 8, 512), ('candidateCount', 16, 4, 128)):
            value = metadata.get(key, default)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError('信念权重配置无效：'+key)
        mixture = metadata.get('priorMixture', .2)
        if not isinstance(mixture, (float, int)) or not .05 <= mixture <= 1:
            raise ValueError('信念权重原采样比例无效')
        model = BeliefNetwork(dimension)
        model.load_state_dict({k: torch.from_numpy(np.array(data['weight:'+k], copy=True))
                               for k in model.state_dict()}, strict=True)
        if not all(torch.isfinite(p).all() for p in model.parameters()):
            raise ValueError('信念权重包含非有限值')
        model.to(device)
        states = {name: {key.rsplit(':', 1)[1]: np.array(data[key], copy=True)
                        for key in data.files if key.startswith('optimizer:'+name+':')}
                  for name, _ in model.named_parameters()}
    return model, metadata, states


def restore_optimizer(model, optimizer, states):
    for name, parameter in model.named_parameters():
        if states.get(name):
            optimizer.state[parameter] = {key: torch.as_tensor(value, device='cpu' if key == 'step' else parameter.device)
                                          for key, value in states[name].items()}
