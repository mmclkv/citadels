"""Isolated belief self-play collection, supervised training and checkpoints."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import copy
import gzip
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import random
import secrets
import threading
import time
import numpy as np
from . import cards
from .belief_encoding import BeliefHistory, observe, labels, contract, C


def normalize_config(value):
    if not isinstance(value, dict):
        raise ValueError('训练配置必须是对象')
    result = {}
    for key, default, lower, upper in (
        ('targetGames', 1000, 1, 10000000), ('minPlayers', 4, 2, 8), ('maxPlayers', 8, 2, 8),
        ('batchGames', 16, 1, 256), ('workers', 1, 1, 8), ('miniBatch', 4, 1, 64),
        ('epochs', 1, 1, 20), ('samplesPerGame', 24, 3, 256), ('sampleEvery', 4, 1, 100),
        ('replayGames', 64, 4, 2048), ('updateSamples', 128, 1, 8192),
        ('historyLength', 128, 8, 512), ('dimension', 128, 64, 192),
        ('maxSteps', 5000, 100, 60000), ('validationEvery', 5, 2, 20),
        ('checkpointEvery', 100, 1, 1000000), ('candidateCount', 16, 4, 128),
        ('seed', 20261018, 0, 2147483647), ('endDistricts', 8, 7, 8)):
        raw = value.get(key, default)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw) or int(raw) != raw or not lower <= raw <= upper:
            raise ValueError(f'{key} 必须是 {lower}–{upper} 的整数')
        result[key] = int(raw)
    for key, default, lower, upper in (('learningRate', .0003, 1e-6, .01),
        ('exploration', .05, 0., .5), ('priorMixture', .2, .05, 1.)):
        raw = value.get(key, default)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw) or not lower <= raw <= upper:
            raise ValueError(f'{key} 数值无效')
        result[key] = float(raw)
    for key, default, options in (('device', 'cpu', ('cpu', 'cuda')),
        ('charSet', 'random', ('base', 'dark', 'mixed', 'random')),
        ('opponents', 'mixed', ('mixed', 'heuristic', 'network'))):
        result[key] = value.get(key, default)
        if result[key] not in options:
            raise ValueError(f'{key} 选项无效')
    result['resumeCheckpoint'] = str(value.get('resumeCheckpoint') or '')
    if result['minPlayers'] > result['maxPlayers'] or result['dimension'] not in (64, 128, 192):
        raise ValueError('人数范围或网络规模无效')
    return result


def save_game(path, samples, metadata):
    arrays = {'metadata': np.array(json.dumps(dict(metadata, contract=contract())))}
    for index, sample in enumerate(samples):
        for group in ('observation', 'target'):
            for key, value in sample[group].items():
                arrays[f'{index}:{group}:{key}'] = value
        arrays[f'{index}:history'] = sample['history']
    temporary = path.with_suffix('.tmp')
    with temporary.open('wb') as handle:
        np.savez_compressed(handle, **arrays)
    os.replace(temporary, path)


def read_game(path):
    with np.load(path, allow_pickle=False) as archive:
        metadata = json.loads(str(archive['metadata']))
        if metadata.get('contract') != contract():
            raise ValueError('信念训练数据编码不匹配')
        samples = []
        for index in range(metadata['samples']):
            sample = {'history': np.array(archive[f'{index}:history'], copy=True)}
            for group in ('observation', 'target'):
                prefix = f'{index}:{group}:'
                sample[group] = {key[len(prefix):]: np.array(archive[key], copy=True)
                                 for key in archive.files if key.startswith(prefix)}
            samples.append(sample)
    return metadata, samples


def compatible_game_paths(dataset, capacity):
    """Select replay games encoded with the active belief observation contract.

    Replay directories can survive an encoder upgrade. Old examples remain
    useful for their original model, but their different target semantics make
    them unsafe to mix into the active replay window.
    """
    compatible, incompatible = [], []
    for path in sorted(dataset.glob('game-*.npz')):
        with np.load(path, allow_pickle=False) as archive:
            metadata = json.loads(str(archive['metadata']))
        (compatible if metadata.get('contract') == contract() else incompatible).append(path)
    return compatible[-capacity:], incompatible


def retain_game(dataset, path, capacity, rng):
    """Half recent games, half reservoir of games leaving the recent window."""
    index_file = dataset/'replay-index.json'
    if index_file.exists():
        index = json.loads(index_file.read_text(encoding='utf-8'))
    else:
        index = dict(recent=[], reservoir=[], seen=0)
        index['recent'] = [p.name for p in sorted(dataset.glob('game-*.npz')) if p != path]
    for group in ('recent', 'reservoir'):
        if any(Path(name).name != name or not name.startswith('game-') or not name.endswith('.npz')
               for name in index[group]):
            raise ValueError('信念回放索引包含无效文件名')
        index[group] = [name for name in index[group] if (dataset/name).is_file()]
    if path.name not in index['recent'] and path.name not in index['reservoir']:
        index['recent'].append(path.name)
    recent_size, reservoir_size = capacity-capacity//2, capacity//2
    discarded = []
    while len(index['recent']) > recent_size:
        incoming = index['recent'].pop(0);index['seen'] += 1
        if len(index['reservoir']) < reservoir_size:
            index['reservoir'].append(incoming)
        else:
            slot = rng.randrange(index['seen'])
            if slot < reservoir_size:
                discarded.append(index['reservoir'][slot]);index['reservoir'][slot] = incoming
            else:
                discarded.append(incoming)
    while len(index['reservoir']) > reservoir_size:
        discarded.append(index['reservoir'].pop())
    temporary = index_file.with_suffix('.tmp')
    temporary.write_text(json.dumps(index), encoding='utf-8');os.replace(temporary, index_file)
    keep = set(index['recent']+index['reservoir'])
    for name in discarded:
        if name not in keep:
            (dataset/name).unlink(missing_ok=True)


def collect_game(engine_path, mcts_path, policy_paths, config, index, stop):
    """Each producer owns its engine; never advances a live room or main trainer."""
    from .game_engine_worker import GameEngineWorker
    from .native_worker import NativeMctsWorker
    from .neural import NeuralPolicy
    rng = random.Random(config['seed']+index*1000003)
    n = rng.randint(config['minPlayers'], config['maxPlayers'])
    if config['opponents'] == 'network':
        network_count = n
    elif config['opponents'] == 'heuristic':
        network_count = 0
    else:
        network_count = rng.randrange(n+1)
    seats = list(range(n));rng.shuffle(seats)
    network_seats = set(seats[:network_count])
    engine = GameEngineWorker(engine_path, env=dict(os.environ, CITADELS_HEURISTIC_MCTS_ENABLED='0'))
    worker, policy = None, None
    try:
        if network_count:
            worker = NativeMctsWorker(mcts_path)
            policy = NeuralPolicy(checkpoint=str(rng.choice(policy_paths)), worker=worker, device='cpu')
            if policy.error:
                raise ValueError(policy.error)
        game_id = 'belief-'+str(index)
        state = engine.create_game({'seed': rng.randrange(2**32), 'endDistricts': config['endDistricts'],
            'charSetMode': config['charSet'], 'catalog': cards._catalog,
            'seats': [{'id': f'p{i}', 'name': f'p{i}', 'isBot': True,
                       'botType': 'neural' if i in network_seats else 'npc',
                       'botLevel': rng.choice(('easy', 'normal', 'hard'))} for i in range(n)]}, game_id)
        history = BeliefHistory(config['historyLength'])
        reservoirs = [[], [], []];seen = [0, 0, 0]
        for step in range(config['maxSteps']):
            if stop.is_set():
                return None
            history.update(state)
            current = engine.current(game_id)
            if current.get('gameOver'):
                break
            if step % config['sampleEvery'] == 0:
                viewer = f'p{rng.randrange(n)}'
                observation = observe(state, viewer)
                target = labels(state, viewer, observation)
                progress = max(len(p['city']) for p in state['players']) / config['endDistricts']
                bucket = 0 if progress < .5 else 1 if progress < .8 else 2
                sample = dict(observation=observation, target=target, history=history.for_player(viewer))
                seen[bucket] += 1
                limit = math.ceil(config['samplesPerGame']/3)
                if len(reservoirs[bucket]) < limit:
                    reservoirs[bucket].append(sample)
                else:
                    slot = rng.randrange(seen[bucket])
                    if slot < limit:
                        reservoirs[bucket][slot] = sample
            decision = engine.decision(game_id)
            actions = decision['actions'];actor = decision['playerId']
            if not actions:
                raise RuntimeError('自对弈无合法动作')
            if rng.random() < config['exploration']:
                action = rng.choice(actions)
            elif actor in {f'p{i}' for i in network_seats} and len(actions) > 1:
                result = worker.search(state=state, particles=[], root_player_id=actor,
                    legal_actions=actions, particle_weights=[1.], model_path=policy.model_path,
                    model_version=1, profile=policy.profile, architecture=policy.architecture,
                    device='cpu', simulations=1, max_depth=1, c_puct=1,
                    dirichlet_alpha=0, dirichlet_epsilon=0, seed=rng.randrange(2**32),
                    action_encoding_version=policy.action_version, policy_only=True)
                action = rng.choices(actions, weights=result['policy'], k=1)[0]
            else:
                action = engine.decide_npc(game_id=game_id, player_id=actor, seed=rng.randrange(2**32),
                                           heuristic_mcts={'timeBudgetMs': 0})
            state = engine.apply(game_id=game_id, player_id=actor, action=action)
        else:
            raise RuntimeError('信念自对弈超过最大步数；未完成的对局不会加入数据集')
        samples = [s for reservoir in reservoirs for s in reservoir]
        rng.shuffle(samples);samples = samples[:config['samplesPerGame']]
        return samples, dict(index=index, players=n, rounds=state.get('round'), networkPlayers=network_count,
                             samples=len(samples), validation=(index+1) % config['validationEvery'] == 0)
    finally:
        engine.close()
        if worker:
            worker.close()
        if policy and policy._model_dir:
            policy._model_dir.cleanup()


class BeliefTrainingManager:
    def __init__(self, data_dir, engine_path=None, mcts_path=None):
        self.root = Path(data_dir)/'belief'
        self.engine_path, self.mcts_path = engine_path, mcts_path
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self._reported_incompatible_games = set()
        self._status = dict(running=False, state='idle', runId='', completedGames=0, totalGames=0, targetGames=0,
            samples=0, error='', logs=[], metrics=None, checkpoint='', config=None, history=[])

    def status(self):
        with self.lock:
            return copy.deepcopy(self._status)

    def log(self, message):
        with self.lock:
            self._status['logs'].append(dict(at=datetime.now(timezone.utc).isoformat(), text=str(message)[:1000]))
            self._status['logs'] = self._status['logs'][-100:]

    def checkpoint_path(self, name):
        if not isinstance(name, str) or Path(name).name != name or not name.startswith('belief-') or not name.endswith('.npz'):
            raise ValueError('信念权重文件名无效')
        path = (self.root/'checkpoints'/name).resolve()
        if not path.is_file() or path.parent != (self.root/'checkpoints').resolve():
            raise ValueError('找不到信念权重')
        return path

    def checkpoints(self):
        result = []
        for path in sorted((self.root/'checkpoints').glob('belief-*.npz'), reverse=True)[:100]:
            try:
                with np.load(path, allow_pickle=False) as data:
                    meta = json.loads(str(data['metadata']))
                if meta.get('architecture') != 'belief-v2-hierarchical':
                    continue
                result.append(dict(name=path.name, games=meta.get('games', 0), dimension=meta.get('dimension'),
                                   historyLength=meta.get('historyLength'), architecture=meta['architecture'],
                                   metrics=meta.get('metrics'), bytes=path.stat().st_size))
            except (OSError, ValueError, KeyError):
                continue
        return result

    def start(self, value):
        config = normalize_config(value)
        with self.lock:
            if self._status['running']:
                raise ValueError('信念训练正在运行')
            if not self.engine_path or not Path(self.engine_path).is_file():
                raise ValueError('需要运行中的 C++ 游戏引擎')
            if config['opponents'] != 'heuristic' and (not self.mcts_path or not Path(self.mcts_path).is_file()):
                raise ValueError('混合/网络对手需要 LibTorch worker；可选择仅启发式对手')
            if config['resumeCheckpoint']:
                self.checkpoint_path(config['resumeCheckpoint'])
            self.stop_event.clear()
            self._status.update(running=True, state='preparing', runId=secrets.token_hex(8), completedGames=0,
                totalGames=0, samples=0, parameterCount=0, targetGames=config['targetGames'],
                error='', logs=[], metrics=None, config=config, checkpoint='', history=[])
            self.thread = threading.Thread(target=self._run, args=(config,), daemon=True)
            self.thread.start()
        return self.status()

    def stop(self):
        self.stop_event.set()
        with self.lock:
            if self._status['running']:
                self._status['state'] = 'stopping'
        return self.status()

    def _run(self, config):
        model = optimizer = None
        base_games, trained = 0, False
        try:
            import torch
            from training.belief_network import BeliefNetwork, load_checkpoint, save_checkpoint, restore_optimizer
            if config['device'] == 'cuda' and not torch.cuda.is_available():
                raise ValueError('CUDA 不可用，请选择 CPU')
            # Local generator only: do not change the live policy's random seeds.
            with torch.random.fork_rng(devices=[]):
                torch.random.default_generator.manual_seed(config['seed'])
                model = BeliefNetwork(config['dimension']).to(config['device'])
            if config['resumeCheckpoint']:
                model, meta, states = load_checkpoint(self.checkpoint_path(config['resumeCheckpoint']), config['device'])
                if meta['dimension'] != config['dimension'] or meta['historyLength'] != config['historyLength']:
                    raise ValueError('续训的网络规模和历史长度必须与权重一致')
                base_games = meta.get('games', 0)
            optimizer = torch.optim.Adam(model.parameters(), lr=config['learningRate'])
            if config['resumeCheckpoint']:
                restore_optimizer(model, optimizer, states)
            dataset = self.root/'games';dataset.mkdir(parents=True, exist_ok=True)
            split_file = self.root/'splits.json'
            splits = json.loads(split_file.read_text(encoding='utf-8')) if split_file.exists() else {}
            run_id = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')+'-'+secrets.token_hex(3)
            self.log('分层信念网络 v2：先估计受约束的角色先验，再估计角色条件手牌后验；策略网络冻结')
            self.log('训练标签来自引擎真实状态；输入仅含观察者可见信息。整局划分训练/验证。')
            policy_paths = []
            if config['opponents'] != 'heuristic':
                from .model_contract import validate_checkpoint_contract
                candidates = [Path(__file__).resolve().parents[1]/'models/policy-default.json.gz']
                historical = sorted(self.root.parent.glob('checkpoint-*.json.gz'))
                indices = sorted({round(i*(len(historical)-1)/7) for i in range(8)}) if historical else []
                candidates += [historical[i] for i in indices]
                for path in candidates:
                    if not path.is_file():
                        continue
                    try:
                        with gzip.open(path, 'rt', encoding='utf-8') as handle:
                            payload = json.load(handle)
                        if (payload.get('model') or {}).get('architecture') != 'entity-v6':
                            raise ValueError('仅支持 entity-v6 数据生成对手')
                        validate_checkpoint_contract(payload, 'entity-v6')
                        policy_paths.append(path)
                        del payload
                    except (OSError, ValueError, KeyError) as exc:
                        self.log('跳过不兼容的策略权重 '+path.name+'：'+str(exc))
            if config['opponents'] != 'heuristic' and not policy_paths:
                raise ValueError('找不到用于生成对局的冻结策略权重')
            with self.lock:
                self._status.update(state='collecting', totalGames=base_games, parameterCount=sum(p.numel() for p in model.parameters()))
            sent, completed = 0, 0
            with ThreadPoolExecutor(max_workers=config['workers']) as executor:
                pending = set()
                while completed < config['targetGames'] and not self.stop_event.is_set():
                    while len(pending) < config['workers'] and sent < config['targetGames']:
                        pending.add(executor.submit(collect_game, self.engine_path, self.mcts_path,
                            policy_paths, config, base_games+sent, self.stop_event));sent += 1
                    done, pending = wait(pending, return_when=FIRST_COMPLETED)
                    for future in done:
                        try:
                            value = future.result()
                        except Exception:
                            self.stop_event.set()
                            raise
                        if value is None:
                            continue
                        samples, meta = value
                        # A rerun/changed validation ratio cannot move the same
                        # seeded game from training into the validation set.
                        split_key = str(config['seed'])+':'+str(meta['index'])
                        meta['validation'] = splits.setdefault(split_key, meta['validation'])
                        split_temp = split_file.with_suffix('.tmp')
                        split_temp.write_text(json.dumps(splits), encoding='utf-8')
                        os.replace(split_temp, split_file)
                        path = dataset/f'game-{run_id}-{meta["index"]:08d}.npz'
                        save_game(path, samples, meta)
                        retain_game(dataset, path, config['replayGames'], random.Random(config['seed']+meta['index']))
                        completed += 1
                        with self.lock:
                            self._status.update(completedGames=completed, totalGames=base_games+completed,
                                samples=self._status['samples']+len(samples))
                        self.log(f'采集 {completed}/{config["targetGames"]} 局：{meta["players"]} 人，{len(samples)} 样本，'
                                 + ('验证集' if meta['validation'] else '训练集'))
                        if completed % config['batchGames'] == 0 or completed == config['targetGames']:
                            metrics = self._update(model, optimizer, config)
                            trained = bool(metrics and metrics['updates']) or trained
                        if trained and (completed % config['checkpointEvery'] == 0 or completed == config['targetGames']):
                            name = f'belief-{base_games+completed:08d}-{run_id}.npz'
                            metadata = dict(games=base_games+completed, historyLength=config['historyLength'], config=config,
                                candidateCount=config['candidateCount'], priorMixture=config['priorMixture'], metrics=self.status()['metrics'])
                            save_checkpoint(self.root/'checkpoints'/name, model, metadata, optimizer)
                            with self.lock:
                                self._status['checkpoint'] = name
                            self.log('已保存 '+name+'；未自动启用到实战')
                    if self.stop_event.is_set():
                        break
            # Save the last completed update when stopping between checkpoint intervals.
            if trained and self.stop_event.is_set():
                name = f'belief-{base_games+completed:08d}-{run_id}.npz'
                save_checkpoint(self.root/'checkpoints'/name, model, dict(games=base_games+completed,
                    historyLength=config['historyLength'], config=config, candidateCount=config['candidateCount'],
                    priorMixture=config['priorMixture'], metrics=self.status()['metrics']), optimizer)
                with self.lock:
                    self._status['checkpoint'] = name
            with self.lock:
                self._status['state'] = 'stopped' if self.stop_event.is_set() else 'completed'
        except Exception as exc:
            self.stop_event.set()
            self.log('错误：'+str(exc))
            with self.lock:
                self._status.update(state='error', error=str(exc))
        finally:
            with self.lock:
                self._status['running'] = False

    def _update(self, model, optimizer, config):
        import torch
        rng = random.Random(config['seed']+self.status()['totalGames'])
        train, validation = [], []
        replay_paths, incompatible_paths = compatible_game_paths(
            self.root/'games', config['replayGames'])
        new_incompatible = {path.name for path in incompatible_paths} - self._reported_incompatible_games
        if new_incompatible:
            self._reported_incompatible_games.update(new_incompatible)
            self.log(f'回放池中有 {len(incompatible_paths)} 局使用旧信念编码，已跳过；旧文件保留。')
        for path in replay_paths:
            meta, samples = read_game(path)
            (validation if meta['validation'] else train).extend(samples)
        if not train:
            self.log('尚无训练局，等待后续采集');return None
        rng.shuffle(train);train = train[:config['updateSamples']]
        rng_validation = random.Random(config['seed']);rng_validation.shuffle(validation)
        validation = validation[:min(64, config['updateSamples'])]
        with self.lock:
            self._status['state'] = 'training'
        model.train();total_loss, updates = 0., 0
        for epoch in range(config['epochs']):
            rng.shuffle(train)
            for start in range(0, len(train), config['miniBatch']):
                if self.stop_event.is_set():
                    break
                batch = train[start:start+config['miniBatch']]
                optimizer.zero_grad(set_to_none=True)
                loss_value = 0.
                for sample in batch:
                    result = model.joint(sample['observation'], sample['history'][-config['historyLength']:], sample['target'])
                    loss = (-result['roleLogProbability']/max(1, result['roleDecisions'])
                            -result['handLogProbability']/max(1, result['handDecisions']))
                    if not torch.isfinite(loss):
                        raise ValueError('信念训练损失包含非有限值')
                    (loss/len(batch)).backward();loss_value += float(loss.detach())/len(batch)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 5.)
                optimizer.step();total_loss += loss_value;updates += 1
                self.log(f'更新 {epoch+1}/{config["epochs"]}，样本 {min(start+len(batch),len(train))}/{len(train)}，loss={loss_value:.4f}')
        model.eval();role_nll, hand_nll, joint_nll = 0., 0., 0.
        roles, hands, evaluated = 0, 0, 0
        with torch.inference_mode():
            for sample in validation:
                if self.stop_event.is_set():
                    break
                result = model.joint(sample['observation'], sample['history'][-config['historyLength']:], sample['target'])
                role_nll -= float(result['roleLogProbability']);hand_nll -= float(result['handLogProbability'])
                joint_nll -= float(result['logProbability']);roles += result['roleDecisions'];hands += len(sample['observation']['handPlayers'])
                evaluated += 1
        metrics = dict(loss=total_loss/max(1,updates), validationSamples=evaluated,
            validationJointNll=joint_nll/evaluated if evaluated else None,
            validationRoleNll=role_nll/roles if roles else None,
            validationHandNll=hand_nll/hands if hands else None,
            trainSamples=len(train), updates=updates, games=self.status()['totalGames'])
        with self.lock:
            self._status.update(metrics=metrics, state='collecting')
            self._status['history'] = (self._status['history']+[metrics])[-100:]
        self.log('验证 NLL：'+(f'{metrics["validationJointNll"]:.3f}' if evaluated else '暂无完整验证局'))
        return metrics
