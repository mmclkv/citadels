"""Version-independent, gzip-compressed display-state delta recordings."""
from __future__ import annotations
import copy, gzip, json, os, re, secrets, time
from pathlib import Path
from .views import sanitize, _hand_card_public, _role, _pending_public

def delta(old, new, path=()):
    if old == new: return []
    if isinstance(old, dict) and isinstance(new, dict):
        changes = [[1, list(path + (k,))] for k in old if k not in new]
        for k, value in new.items():
            changes += delta(old[k], value, path + (k,)) if k in old else [[0, list(path + (k,)), value]]
        return changes
    if isinstance(old, list) and isinstance(new, list):
        if len(new) > len(old) and new[:len(old)] == old: return [[2, list(path), new[len(old):]]]
        if len(old) == len(new):
            return [change for i in range(len(old)) for change in delta(old[i], new[i], path + (i,))]
    return [[0, list(path), new]]

def apply_delta(state, changes):
    for operation, path, *values in changes:
        if not path:
            if operation == 0: state = copy.deepcopy(values[0])
            elif operation == 2: state.extend(copy.deepcopy(values[0]))
            continue
        parent = state
        for key in path[:-1]: parent = parent[key]
        key = path[-1]
        if operation == 0: parent[key] = copy.deepcopy(values[0])
        elif operation == 1: del parent[key]
        elif operation == 2: parent[key].extend(copy.deepcopy(values[0]))
        else: raise ValueError("Invalid replay operation")
    return state

def recording_view(state):
    view = sanitize(state, None, [])
    for row, player in zip(view['players'], state['players']):
        row.pop('connected', None)
        row['hand'] = [_hand_card_public(c, set()) for c in player['hand']]
        row['chars'] = [{**_role(c), 'played': c in player['played']} for c in player['chars']]
    if view.get('draft'):
        view['draft']['pool'] = [_role(c) for c in state['draft']['pool']]
    if view.get('turn') and (state.get('turn') or {}).get('pending'):
        view['turn']['pending'] = _pending_public(state['turn']['pending'], True)
    view.pop('available', None)
    view.pop('log', None)
    logs = [entry for entry in state.get('log', []) if 'visibleTo' not in entry]
    return view, logs

class Recorder:
    def __init__(self, room, version):
        self.token = room['state'].get('createdAt')
        self.started = self.token or int(time.time()*1000)
        self.id = f"{int(time.time()*1000)}-{secrets.token_hex(8)}"
        self.room_name = room.get('name', room['id'])
        self.version = version
        self.previous = None
        self.logs = []
        self.initial = None
        self.steps = []
        self.saved = False
    def observe(self, state, actor=None, action=None):
        view, logs = recording_view(state)
        shared = min(len(logs), len(self.logs))
        while shared and self.logs[-shared:] != logs[:shared]: shared -= 1
        events = [{k:v for k,v in entry.items() if k != 'i'} for entry in logs[shared:]]
        self.logs = copy.deepcopy(logs)
        if self.previous is None:
            self.initial = copy.deepcopy(view)
            self.steps.append({'d': [], 'e': events})
        else:
            changes = delta(self.previous, view)
            if not changes and not events and action is None: return
            step = {'d': copy.deepcopy(changes), 'e': copy.deepcopy(events)}
            if action is not None: step['a'] = {'playerId': actor, 'action': copy.deepcopy(action)}
            self.steps.append(step)
        self.previous = copy.deepcopy(view)
    def payload(self):
        final = self.previous
        winner = final.get('winner')
        names = [p['name'] for p in final['players']]
        meta = {'id':self.id, 'roomName':self.room_name, 'startedAt':self.started,
                'endedAt':int(time.time()*1000), 'players':names, 'playerCount':len(names),
                'rounds':final['round'], 'steps':len(self.steps), 'winner':winner,
                'scores':final.get('scores',[]), 'version':self.version,
                'scenario':final.get('config',{}).get('scenario','')}
        return {'format':1, 'meta':meta, 'initial':self.initial, 'steps':self.steps}

class ReplayStore:
    def __init__(self, directory): self.directory = Path(directory)
    def _path(self, identity):
        if not re.fullmatch(r"[0-9]{13}-[0-9a-f]{16}", identity): raise ValueError("录像编号无效")
        return self.directory / (identity + '.json.gz')
    def save(self, recorder):
        if recorder.saved: return
        if not recorder.previous or recorder.previous.get('phase') != 'gameover':
            raise ValueError("只能保存已完成的对局")
        self.directory.mkdir(parents=True, exist_ok=True)
        data = recorder.payload()
        raw = json.dumps(data, ensure_ascii=False, separators=(',',':'), allow_nan=False).encode()
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        path = self._path(recorder.id)
        pending = path.with_suffix('.tmp')
        pending.write_bytes(compressed); os.replace(pending, path)
        # Tiny sidecars keep history listing independent of decompressing all games.
        meta = {**data['meta'], 'bytes':len(compressed)}
        sidecar = path.with_suffix('.meta.json')
        pending = sidecar.with_suffix('.tmp')
        pending.write_text(json.dumps(meta,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
        os.replace(pending, sidecar)
        recorder.saved = True
    def read(self, identity):
        data = json.loads(gzip.decompress(self._path(identity).read_bytes()))
        if data.get('format') != 1: raise ValueError("不支持的录像版本")
        return data
    def listing(self, offset=0, limit=30):
        # Recover a completed atomic recording if interrupted before its sidecar.
        for path in self.directory.glob('*.json.gz'):
            sidecar = path.with_suffix('.meta.json')
            if not sidecar.exists():
                try:
                    data = self.read(path.name[:-8]); meta = {**data['meta'],'bytes':path.stat().st_size}
                    sidecar.write_text(json.dumps(meta,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
                except (OSError,ValueError,KeyError,EOFError): continue
        entries = []
        for path in sorted(self.directory.glob('*.json.meta.json'), reverse=True):
            try: entries.append(json.loads(path.read_text(encoding='utf-8')))
            except (OSError,ValueError): continue
        entries.sort(key=lambda item:(item.get('endedAt',0),item['id']), reverse=True)
        return {'replays':entries[offset:offset+limit], 'total':len(entries), 'offset':offset, 'limit':limit}
