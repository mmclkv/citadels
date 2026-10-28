"""Role-stratified importance resampling of legal native hidden worlds."""
from __future__ import annotations
import os
import math
import random
import threading
import time
from pathlib import Path
import numpy as np
from .belief_encoding import VERSION, BeliefHistory, observe, labels, prior_hand_log_probability


class BeliefPolicy:
    def __init__(self, checkpoint=None):
        self._lock = threading.RLock()
        self.model = None
        self.metadata = {}
        self.checkpoint = ''
        self.error = ''
        self.last = None
        self.histories = {}
        path = checkpoint or os.environ.get('CITADELS_BELIEF_CHECKPOINT')
        if path:
            try:
                self.load(path)
            except Exception as exc:
                self.error = str(exc)

    def load(self, path):
        from training.belief_network import load_checkpoint
        model, metadata, _ = load_checkpoint(path, 'cpu')
        model.eval()
        with self._lock:
            self.model, self.metadata = model, metadata
            self.checkpoint, self.error = str(Path(path).resolve()), ''
            self.last = None
            self.histories.clear()

    def status(self):
        with self._lock:
            return dict(configured=self.model is not None, checkpoint=Path(self.checkpoint).name,
                        architecture='belief-v2-hierarchical', architectureVersion=2,
                        encodingVersion=VERSION, error=self.error,
                        games=self.metadata.get('games', 0), last=self.last)

    def disable(self):
        with self._lock:
            self.model = None;self.histories.clear();self.checkpoint = '';self.error = '';self.last = None

    def update(self, state):
        with self._lock:
            if self.model is None:
                return
            key = (state.get('roomId', ''), state.get('createdAt', 0))
            history = self.histories.get(key)
            if history is None:
                if len(self.histories) >= 64:
                    self.histories.pop(next(iter(self.histories)))
                history = self.histories[key] = BeliefHistory(self.metadata.get('historyLength', 128))
            history.update(state)

    def sample(self, worker, state, viewer_id, count, seed, enabled=True):
        with self._lock:
            self.last = None
            pending = ((state.get('turn') or {}).get('pending') or {}).get('kind')
            # Special private navigation has pinned zones; retain the proven native
            # sampler until its proposal likelihood is explicitly supported.
            if not enabled or self.model is None or pending or state.get('reaction'):
                return worker.determinize(state=state, player_id=viewer_id, count=count, seed=seed, belief=enabled)

            start = time.perf_counter()
            try:
                import torch
                self.update(state)
                key = (state.get('roomId', ''), state.get('createdAt', 0))
                history = self.histories[key].for_player(viewer_id)
                observation = observe(state, viewer_id)
                candidates = max(count, min(128, int(self.metadata.get('candidateCount', 16))))
                sampled = worker.determinize(state=state, player_id=viewer_id, count=candidates, seed=seed, belief=False)
                worlds = sampled['particles']
                targets = [labels(s, viewer_id, observation) for s in worlds]
                with torch.inference_mode():
                    role_logp, hand_logp = self.model.score_candidate_components(observation, history, targets)
                    role_logp = role_logp.cpu().numpy().astype(float)
                    hand_logp = hand_logp.cpu().numpy().astype(float)
                hand_logq = np.array([prior_hand_log_probability(s, viewer_id, observation) for s in worlds])
                hand_logits = hand_logp-hand_logq
                if not np.isfinite(role_logp).all() or not np.isfinite(hand_logits).all():
                    raise ValueError('信念网络返回无效概率')
                joint_logits = role_logp+hand_logits
                # Estimate each role hypothesis' marginal mass first:
                # P(R|I) * E_q(H|R)[P(H|R,I)/q(H|R)].
                role_groups = {}
                for index, target in enumerate(targets):
                    key_role = tuple(int(x) for x in target['roles'])
                    role_groups.setdefault(key_role, []).append(index)
                keys = list(role_groups)
                role_mass = []
                hand_weights = {}
                for key_role in keys:
                    indices = role_groups[key_role]
                    local = np.exp(hand_logits[indices]-np.max(hand_logits[indices]))
                    # Restore the scale before estimating the conditional integral.
                    log_mean = float(np.max(hand_logits[indices]) + np.log(local.mean()))
                    role_mass.append(float(role_logp[indices[0]] + log_mean))
                    local /= local.sum()
                    hand_weights[key_role] = (indices, local)
                role_mass = np.asarray(role_mass, dtype=float)
                role_weights = np.exp(role_mass-role_mass.max());role_weights /= role_weights.sum()
                mixture = float(self.metadata.get('priorMixture', .2))
                role_weights = (1-mixture)*role_weights + mixture/len(role_weights)
                rng = random.Random(seed ^ 0xB311EF)
                # Systematic resampling reduces the chance that a high-mass role
                # hypothesis is missed by a small particle budget.
                positions = (rng.random()+np.arange(count))/count
                role_indices = np.searchsorted(np.cumsum(role_weights), positions, side='right')
                selected, selected_log_weights = [], []
                for role_index in role_indices:
                    key_role = keys[min(int(role_index), len(keys)-1)]
                    indices, conditional = hand_weights[key_role]
                    conditional = (1-mixture)*conditional + mixture/len(conditional)
                    chosen = rng.choices(range(len(indices)), weights=conditional, k=1)[0]
                    selected_index = indices[chosen]
                    selected.append(selected_index)
                    # Match the scale of the native proposal weights used for
                    # candidates added later by progressive root sampling.
                    proposal_mass = role_weights[min(int(role_index), len(keys)-1)]*conditional[chosen]
                    selected_log_weights.append(float(joint_logits[selected_index]-math.log(proposal_mass)-math.log(len(worlds))))
                self.last = dict(milliseconds=round((time.perf_counter()-start)*1000, 2), candidates=len(worlds),
                                 roleHypotheses=len(keys), particles=count,
                                 uniqueRoles=len({keys[int(i)] for i in role_indices}),
                                 uniqueParticles=len(set(selected)), effectiveRoleSamples=float(1/np.square(role_weights).sum()))
                self.error = ''
                return dict(particles=[worlds[i] for i in selected], weights=[1.]*count,
                            logWeights=selected_log_weights, modelApplied=True)
            except Exception as exc:
                self.error = str(exc)
                result = worker.determinize(state=state, player_id=viewer_id, count=count, seed=seed, belief=enabled)
                result['modelApplied'] = False
                return result

    def candidate_scorer(self, state, viewer_id, enabled=True):
        """Freeze one model and one real observation for an entire search.

        Return unnormalised log importance weights on a common scale. Pool-wide
        normalisation and the prior mixture happen in C++, including duplicates;
        normalising each incoming batch would change its probability mass.
        """
        with self._lock:
            pending = ((state.get('turn') or {}).get('pending') or {}).get('kind')
            if not enabled or self.model is None or pending or state.get('reaction'):
                return None
            self.update(state)
            key = (state.get('roomId', ''), state.get('createdAt', 0))
            observation = observe(state, viewer_id)
            history = self.histories[key].for_player(viewer_id).copy()
            model = self.model
            mixture = float(self.metadata.get('priorMixture', .2))
            if not math.isfinite(mixture) or not 0 <= mixture <= 1:
                raise ValueError('信念网络 priorMixture 无效')

        def score(worlds):
            import torch
            targets = [labels(world, viewer_id, observation) for world in worlds]
            with torch.inference_mode():
                role_logp, hand_logp = model.score_candidate_components(observation, history, targets)
                role_logp = role_logp.cpu().numpy().astype(float)
                hand_logp = hand_logp.cpu().numpy().astype(float)
            logq = np.array([prior_hand_log_probability(world, viewer_id, observation) for world in worlds])
            weights = role_logp + hand_logp - logq
            if not np.isfinite(weights).all():
                raise ValueError('信念网络返回无效概率')
            return weights.tolist()

        return score, mixture
