"""Versioned, viewer-only observations. Hidden labels are built separately."""
from __future__ import annotations

from collections import deque
import numpy as np
from .cards import DISTRICTS, CHARACTERS

VERSION = 1
CARD_IDS = tuple(c['en'] for c in DISTRICTS)
ROLE_IDS = tuple(c['id'] for c in CHARACTERS)
CARD_INDEX = {name: i for i, name in enumerate(CARD_IDS)}
ROLE_INDEX = {name: i for i, name in enumerate(ROLE_IDS)}
C, R, MAX_PLAYERS = len(CARD_IDS), len(ROLE_IDS), 8
COPIES = np.array([c['count'] for c in DISTRICTS], dtype=np.int64)
M = int(COPIES.max())
PLAYER_SIZE = 8 + C * 2 + R
GLOBAL_SIZE = 16 + R * 2 + C
EVENT_SIZE = 16 + 24 + C * 3 + R + 8
PHASES = ('lobby', 'draft', 'action', 'reaction', 'roundConfirm', 'gameover')


def contract():
    return dict(version=VERSION, cards=list(CARD_IDS), roles=list(ROLE_IDS),
                copies=COPIES.tolist(), playerSize=PLAYER_SIZE, globalSize=GLOBAL_SIZE,
                eventSize=EVENT_SIZE, maxCopies=M)


def card_counts(cards):
    result = np.zeros(C, dtype=np.int64)
    for card in cards:
        index = CARD_INDEX.get(card.get('en'))
        if index is not None:
            result[index] += 1
    return result


def role_id(value):
    return value.get('id') if isinstance(value, dict) else value


def known_roles(state, index, viewer):
    player = state['players'][index]
    result = {role_id(r) for r in player.get('played', [])}
    if index == viewer:
        result.update(role_id(r) for r in player.get('chars', []))
    # The Witch can publicly play another role while the call queue retains
    # that role's original owner. Execution is not ownership.
    effects = state.get('effects') or {}
    borrowed = set()
    if state.get('phase') not in ('draft', 'lobby') and (state.get('turn') or {}).get('phase') != 'setup':
        for call_index, entry in enumerate(state.get('callQueue', [])):
            if (call_index <= state.get('callIdx', -1) and entry.get('num') == effects.get('bewitched')
                    and entry.get('num') != effects.get('assassinated')):
                if entry.get('playerIdx') == index:
                    result.add(entry.get('charId'))
                elif effects.get('witchBy') == index:
                    borrowed.add(entry.get('charId'))
    result.difference_update(borrowed)
    turn = state.get('turn') or {}
    if state.get('phase') == 'action' and turn.get('phase') not in ('setup', 'witch_resume') and turn.get('playerIdx') == index:
        result.add(turn.get('charId'))
    return {r for r in result if r in ROLE_INDEX}


def visible_hand(state, index, viewer):
    if index == viewer:
        return True
    turn = state.get('turn') or {}
    pending = turn.get('pending') or {}
    return (turn.get('playerIdx') == viewer and pending.get('kind') in ('wizard_card', 'wizard_choice')
            and pending.get('targetIdx') == index)


def observe(state, viewer_id):
    """Explicit allow-list; never reads opponent card identities or hidden roles."""
    players = state['players']
    viewer = next(i for i, p in enumerate(players) if p['id'] == viewer_id)
    n = len(players)
    rows = np.zeros((8, PLAYER_SIZE), dtype=np.float32)
    mask = np.zeros(8, dtype=np.bool_)
    remaining = COPIES.copy()
    allowed = np.zeros(R, dtype=np.bool_)
    for role in state.get('charDeck', []):
        index = ROLE_INDEX.get(role_id(role))
        if index is not None:
            allowed[index] = True
    role_slots, hand_players, hand_sizes = [], [], []
    for relative in range(n):
        index = (viewer + relative) % n
        p = players[index]
        mask[relative] = True
        city = card_counts(p.get('city', []))
        known = known_roles(state, index, viewer)
        # Selection status and number of role slots are public, not their identity.
        slot_count = len(p.get('chars', []))
        row = rows[relative]
        row[:8] = [p.get('gold', 0) / 20, len(p.get('hand', [])) / 20,
                   len(p.get('city', [])) / 8, bool(p.get('hasCrown')), relative == 0,
                   slot_count / 2, len(known) / 2, visible_hand(state, index, viewer)]
        row[8:8+C] = city / 5
        remaining -= city
        if visible_hand(state, index, viewer):
            hand = card_counts(p.get('hand', []))
            row[8+C:8+C*2] = hand / 5
            remaining -= hand
        else:
            hand_players.append(relative)
            hand_sizes.append(len(p.get('hand', [])))
        for role in known:
            row[8+C*2+ROLE_INDEX[role]] = 1
            allowed[ROLE_INDEX[role]] = False
        role_slots.extend([relative] * max(0, slot_count-len(known)))
    draft = state.get('draft') or {}
    face_up = draft.get('faceUp', (state.get('draftPublic') or {}).get('faceUp', []))
    for role in face_up:
        index = ROLE_INDEX.get(role_id(role))
        if index is not None:
            allowed[index] = False
    global_features = np.zeros(GLOBAL_SIZE, dtype=np.float32)
    phase = state.get('phase', 'lobby')
    global_features[PHASES.index(phase) if phase in PHASES else 0] = 1
    turn = state.get('turn') or {}
    global_features[6:12] = [state.get('round', 0)/30, n/8,
        (state.get('config') or {}).get('endDistricts', 8)/8,
        turn.get('takenResources', False), turn.get('incomeTaken', False), turn.get('builds', 0)/3]
    active = turn.get('playerIdx')
    global_features[12] = bool(turn.get('abilityUsed'))
    global_features[13] = ((active-viewer) % n+1)/8 if isinstance(active, int) and 0 <= active < n else 0
    public_role = ROLE_INDEX.get(turn.get('charId')) if turn.get('phase') != 'setup' else None
    global_features[14] = (public_role+1)/R if public_role is not None else 0
    global_features[15] = bool(turn.get('pending'))
    # Only the viewer who is choosing can see the draft pool.
    steps = draft.get('steps', [])
    step_index = draft.get('stepIdx', -1)
    if 0 <= step_index < len(steps) and steps[step_index].get('player') == viewer:
        if not steps[step_index].get('fromFaceDown'):
            for role in draft.get('pool', []):
                index = ROLE_INDEX.get(role_id(role))
                if index is not None:
                    global_features[16+R+index] = 1
                    allowed[index] = False
    global_features[16:16+R] = allowed
    # Catalogue bounds, not the identities/composition of actual hidden zones.
    remaining = np.maximum(remaining, 0)
    global_features[16+R*2:] = remaining / 5
    return dict(players=rows, playerMask=mask, globalFeatures=global_features,
                roleAllowed=allowed, rolePlayers=np.array(role_slots, dtype=np.int64),
                handPlayers=np.array(hand_players, dtype=np.int64),
                handSizes=np.array(hand_sizes, dtype=np.int64), remaining=remaining)


def labels(state, viewer_id, observation):
    """Ground truth only. Never pass this result into an observation encoder."""
    viewer = next(i for i, p in enumerate(state['players']) if p['id'] == viewer_id)
    n = len(state['players'])
    roles = []
    for relative in sorted(set(observation['rolePlayers'].tolist())):
        index = (viewer+relative) % n
        known = known_roles(state, index, viewer)
        roles.extend(sorted(ROLE_INDEX[role_id(r)] for r in state['players'][index].get('chars', [])
                            if role_id(r) not in known))
    hands = [card_counts(state['players'][(viewer+int(r)) % n]['hand'])
             for r in observation['handPlayers']]
    return dict(roles=np.array(roles, dtype=np.int64), hands=np.array(hands, dtype=np.int64).reshape(-1, C))


def event(previous, current):
    value = np.zeros(EVENT_SIZE, dtype=np.float32)
    value[:16] = current['globalFeatures'][:16]
    if previous is not None:
        value[16:40] = (current['players'][:, :3]-previous['players'][:, :3]).reshape(-1)
        value[40:40+C] = (current['players'][:, 8:8+C]-previous['players'][:, 8:8+C]).sum(0)
    # Preserve previously seen draft choices and own roles after the phase changes.
    value[40+C:40+C+R] = np.maximum(current['globalFeatures'][16+R:16+R*2],
                                   current['players'][0, 8+C*2:])
    offset = 40+C+R
    value[offset:offset+C] = current['players'][0, 8+C:8+C*2]
    value[offset+C:offset+C*2] = current['players'][1:, 8+C:8+C*2].sum(0)
    value[offset+C*2:] = current['players'][:, 7]
    return value


class BeliefHistory:
    def __init__(self, length=128):
        self.length = length
        self.previous = {}
        self.events = {}

    def update(self, state):
        for player in state['players']:
            key = player['id']
            observation = observe(state, key)
            previous = self.previous.get(key)
            # Broadcasts and duplicate snapshots must not add fictitious evidence.
            if previous is not None and all(np.array_equal(observation[k], previous[k])
                                           for k in ('players', 'globalFeatures')):
                continue
            self.events.setdefault(key, deque(maxlen=self.length)).append(event(previous, observation))
            self.previous[key] = observation

    def for_player(self, player_id):
        return np.array(self.events.get(player_id, []), dtype=np.float32).reshape(-1, EVENT_SIZE)


def prior_hand_log_probability(state, viewer_id, observation):
    """Count-level likelihood under native uniform redistribution (ordinary states)."""
    import math
    viewer = next(i for i, p in enumerate(state['players']) if p['id'] == viewer_id)
    pool = list(state.get('deck', [])) + list(state.get('discard', []))
    for i, p in enumerate(state['players']):
        if i != viewer:
            pool += p.get('hand', [])
            for district in p.get('city', []):
                pool += district.get('museum', [])
    counts = card_counts(pool)
    target = labels(state, viewer_id, observation)['hands']
    total = 0.
    def log_comb(n, k):
        return math.lgamma(n+1)-math.lgamma(k+1)-math.lgamma(n-k+1)
    for hand in target:
        total += sum(log_comb(int(n), int(k)) for n, k in zip(counts, hand))
        total -= log_comb(int(counts.sum()), int(hand.sum()))
        counts -= hand
    return total
