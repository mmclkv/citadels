"""Optional learned importance resampling of legal native hidden worlds."""
from __future__ import annotations
import os
import random
import threading
import time
from pathlib import Path
import numpy as np
from .belief_encoding import BeliefHistory, observe, labels, prior_hand_log_probability


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
                        architecture='belief-v1', encodingVersion=1, error=self.error,
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
                    logp = self.model.score_candidates(observation, history, targets).cpu().numpy().astype(float)
                logq = np.array([prior_hand_log_probability(s, viewer_id, observation) for s in worlds])
                logits = logp-logq
                if not np.isfinite(logits).all():
                    raise ValueError('信念网络返回无效概率')
                weights = np.exp(logits-logits.max());weights /= weights.sum()
                mixture = float(self.metadata.get('priorMixture', .2))
                weights = (1-mixture)*weights+mixture/len(weights)
                indices = random.Random(seed ^ 0xB311EF).choices(range(len(worlds)), weights=weights, k=count)
                self.last = dict(milliseconds=round((time.perf_counter()-start)*1000, 2), candidates=len(worlds),
                                 particles=count, uniqueParticles=len(set(indices)),
                                 effectiveSamples=float(1/np.square(weights).sum()))
                self.error = ''
                return dict(particles=[worlds[i] for i in indices], weights=[1.]*count)
            except Exception as exc:
                self.error = str(exc)
                return worker.determinize(state=state, player_id=viewer_id, count=count, seed=seed, belief=enabled)
