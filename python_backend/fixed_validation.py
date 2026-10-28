"""Frozen whole-game validation, isolated from both training and replay.

Targets describe the behavior at collection time, not the value of every future
policy. Use this calibration benchmark alongside a separate strength arena.
"""
import gzip
import hashlib
import json
from pathlib import Path
import numpy as np
from .model_contract import config_contract


def validation_sample_seed(config, index):
    """Choose seeds outside this run's ordinary game-seed range."""
    multiplier = 0x9E3779B1
    modulus = 1 << 32
    origin = int(config['seed']) & 0xFFFFFFFF
    target = int(config['targetGames'])
    if not 0 <= target < modulus - 1024:
        raise ValueError('Target games leave no disjoint uint32 validation seed domain')
    # A disjoint portion of the SAME bijective seed stream; no chance of overlap
    # with ordinary training numbers 1..targetGames, even after resume.
    return (origin + (target + 1 + index) * multiplier) & 0xFFFFFFFF


class FixedValidation:
    def __init__(self, directory, config):
        self.config = dict(config)
        self.capacity = int(config.get('validationGames', 32))
        self.contract = config_contract(config)
        identity = {key: config.get(key) for key in ('seed', 'targetGames', 'charSet', 'endDistricts',
                    'minPlayers', 'maxPlayers', 'gameEnginePath')}
        for key in ("seed", "targetGames", "endDistricts", "minPlayers", "maxPlayers"):
            if identity[key] is not None: identity[key] = int(identity[key])
        identity.update(self.contract)
        self.identity = identity
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
        self.path = Path(directory) / 'validation' / f'fixed-{digest}.json.gz'
        self.games = {}
        if self.capacity and self.path.exists():
            with gzip.open(self.path, 'rb') as handle:
                raw = handle.read(128 * 1024 * 1024 + 1)
            if len(raw) > 128 * 1024 * 1024:
                raise ValueError('Fixed validation exceeds 128 MiB')
            saved = json.loads(raw)
            if saved.get('identity') != identity:
                raise ValueError('Fixed validation identity mismatch')
            for game in saved['games']:
                self._validate_rows(game['rows'])
                self.games[int(game['index'])] = game

    @property
    def game_count(self):
        return sum(0 <= index < self.capacity for index in self.games)

    def _validate_rows(self, rows):
        for row in rows:
            if (np.asarray(row['state']).shape != (self.contract['stateSize'],) or
                np.asarray(row['reward']).shape != (8,) or np.asarray(row['valueMask']).shape != (8,)):
                raise ValueError('Fixed validation feature dimensions mismatch')
            a=np.asarray(row['actions']).reshape((-1,self.contract['actionSize']))
            if len(a) != len(row['pi']): raise ValueError('Fixed validation policy dimensions mismatch')
            for key in ('state','actions','pi','reward','valueMask'):
                if not np.isfinite(np.asarray(row[key])).all():
                    raise ValueError('Fixed validation contains nonfinite features')

    def tasks(self, history_available):
        from .batch_composition import balanced_game_compositions
        count = int(self.config.get('validationGamesPerBatch',2))
        missing = [i for i in range(self.capacity) if i not in self.games][:count]
        tasks=[]
        for index in missing:
            seed=validation_sample_seed(self.config,index)
            cfg={**self.config,'seed':seed}
            composition=balanced_game_compositions(cfg,[index+1],history_available)[0]
            tasks.append({'validationIndex':index,'gameNumber':index+1,'composition':composition,
                          'sampleSeed':seed})
        return tasks

    def add(self, result):
        index=int(result['validationIndex'])
        if index in self.games or not result['completed'] or not result['rows']: return False
        if not 0<=index<self.capacity: raise ValueError('Invalid validation game index')
        if result['sampleSeed'] != validation_sample_seed(self.config,index):
            raise ValueError('Validation game entered the wrong seed domain')
        rows=result['rows']
        # Even coverage of a whole trajectory; cap storage and validation cost.
        indices=np.linspace(0,len(rows)-1,min(128,len(rows)),dtype=int)
        serial=[{key:np.asarray(rows[int(i)][key]).tolist() for key in
                 ('state','actions','pi','reward','valueMask')} for i in indices]
        self._validate_rows(serial)
        self.games[index]={'index':index,'sampleSeed':result['sampleSeed'],'rows':serial}
        self.path.parent.mkdir(parents=True,exist_ok=True)
        temporary=self.path.with_suffix('.tmp')
        temporary.write_bytes(gzip.compress(json.dumps({'identity':self.identity,'games':list(self.games.values())},
                               separators=(',',':'),allow_nan=False).encode(),mtime=0))
        temporary.replace(self.path)
        return True

    def rows(self):
        result=[]
        for index in sorted(self.games):
            if index>=self.capacity: continue
            for row in self.games[index]['rows']:
                value={key:np.asarray(item,dtype=np.float32) for key,item in row.items()}
                value['actions']=value['actions'].reshape((-1,self.contract['actionSize']))
                result.append(value)
        return result


def evaluate_fixed_validation(model, device, rows, contract, batch_size=128):
    """Forward passes only. Report policy fit and value error by seat/phase/count."""
    if not rows: return {}
    import torch
    from .training_runtime import _training_data
    from training.gpu_trainer import build_minibatch
    data=_training_data(torch,rows,contract)
    records=[]
    was_training=model.training
    model.eval()
    try:
        with torch.inference_mode():
            for start in range(0,len(rows),batch_size):
                indices=np.arange(start,min(len(rows),start+batch_size))
                b=build_minibatch(data,indices,device)
                logits,values=model(b['states'],b['actions'],b['masks'])
                probs=logits.softmax(-1).cpu().numpy(); values=values.cpu().numpy()
                for i,index in enumerate(indices):
                    row=rows[int(index)];n=int(row['valueMask'].sum())
                    if not 1<=n<=8: raise ValueError('Invalid validation value mask')
                    y=row['reward'][:n];v=values[i,:n]
                    progress=max(float(row['state'][32+p*184+2]) for p in range(n))
                    record={'value':float(np.mean((v-y)**2)), 'own':float((v[0]-y[0])**2),
                            'baseline':float(np.mean(((-.9+1.8/n)-y)**2)),
                            'winner':float(y[v.argmax()]==y.max()), 'players':n,
                            'stage':'early' if progress<.5 else 'middle' if progress<.875 else 'late',
                            'actor':'neural' if row['state'][49]>.9 else 'heuristic'}
                    if len(row['pi'])>1:
                        target=row['pi']/max(float(row['pi'].sum()),1e-12)
                        p=probs[i,:len(target)];p=p/max(float(p.sum()),1e-12)
                        record['policy']=float(-np.sum(target*np.log(np.maximum(p,1e-12))))
                        record['kl']=float(np.sum(target*np.log(np.maximum(target,1e-12)/np.maximum(p,1e-12))))
                    records.append(record)
    finally:
        model.train(was_training)
    def summarize(group):
        return {'samples':len(group),**{key:float(np.mean([r[key] for r in group if key in r]))
                for key in ('value','own','baseline','winner','policy','kl') if any(key in r for r in group)}}
    summary=summarize(records)
    return {'validationSamples':len(records),'validationValueLoss':summary['value'],
            'validationOwnValueLoss':summary['own'],'validationBaselineValueLoss':summary['baseline'],
            'validationWinnerAccuracy':summary['winner'],'validationPolicyLoss':summary.get('policy'),
            'validationPolicyKl':summary.get('kl'),
            'validationByPlayers':{str(n):summarize([r for r in records if r['players']==n]) for n in sorted({r['players'] for r in records})},
            'validationByStage':{s:summarize([r for r in records if r['stage']==s]) for s in ('early','middle','late') if any(r['stage']==s for r in records)},
            'validationByActor':{s:summarize([r for r in records if r['actor']==s]) for s in ('neural','heuristic') if any(r['actor']==s for r in records)}}
