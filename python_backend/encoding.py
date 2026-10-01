"""Python implementation of the current entity-v5 state/action encodings."""

from __future__ import annotations

import math
import re
from typing import Any

import numpy as np

from .cards import DISTRICTS

STATE_SIZE = 672
ACTION_SIZE = 256
STATE_ENCODING_VERSION = 11
ACTION_ENCODING_VERSION = 8
ROLE_IDS = ['assassin', 'witch', 'thief', 'magician', 'prophet', 'king', 'emperor', 'noble',
            'bishop', 'monk', 'merchant', 'alchemist', 'businessman', 'architect', 'navigator', 'scholar',
            'warlord', 'diplomat', 'marshal', 'queen', 'artist', 'magistrate', 'spy', 'blackmailer',
            'wizard', 'abbot', 'tax_collector']
PHASE_CODES = {'lobby': 0, 'draft': 1, 'action': 2, 'reaction': 3, 'roundConfirm': 4, 'gameover': 5}
TURN_PHASE_CODES = {'main': 0, 'witch_resume': 1, 'draw_keep': 2, 'scholar_pick': 3}
PENDING_CODES = dict(zip(('assassin thief witch_target magician_choice magician_swap magician_redraw warlord_destroy '
    'marshal_seize artist navigator_bonus monk_declare emperor_crown emperor_take prophet_give draw_keep scholar_pick '
    'diplomat_mine diplomat_theirs magistrate_declare magistrate_second magistrate_third blackmailer_declare '
    'blackmailer_second blackmailer_signed blackmailer_threat spy_target spy_color wizard_target wizard_card '
    'wizard_choice abbot_declare tax_collect bishop_payer bishop_repay').split(), range(1, 35)))
ACTION_TYPES = ('ability_skip ability abbot_resource artist_done blackmailer_bribe blackmailer_refuse blackmailer_signed '
    'blackmailer_char build choose_cards choose_char choose_district choose_player confirm_round draft_discard draft_pick '
    'draw_keep emperor_crown emperor_take end_turn income lab magician_mode magistrate_signed magistrate_char monk_resource '
    'monk_take museum navigator_bonus pending_back prophet_give reaction scholar_pick smithy spy_color spy_target take_cards '
    'take_gold tax_collect wizard_build wizard_card wizard_take wizard_target').split()
CARD_INDEX = {card['en']: (i, card['count']) for i, card in enumerate(DISTRICTS)}
ROLE_NUM = dict(zip(ROLE_IDS, (1, 1, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 1, 2, 2, 3, 5, 9)))
COLOR_INDEX = {'yellow': 0, 'blue': 1, 'green': 2, 'red': 3, 'purple': 4}
IGNORE_KEYS = {'log', 'notices', 'available', 'roomName', 'name', 'label', 'desc', 'resumeToken'}


def observation_context(view: dict, player_id: str) -> dict:
    players = view.get('players') or []
    me = next((i for i, p in enumerate(players) if p.get('id') == player_id), -1)
    me = max(0, me)
    player_ids = {p.get('id'): (i - me + len(players)) % len(players) for i, p in enumerate(players)} if players else {}
    card_ids, cards = {}, {}
    def collect(value: Any) -> None:
        if isinstance(value, list):
            for item in value: collect(item)
        elif isinstance(value, dict):
            uid = value.get('uid')
            if uid:
                card_ids[uid] = value.get('id') or value.get('en') or value.get('name') or f"{value.get('color')}:{value.get('cost')}"
                cards[uid] = value
            for key, item in value.items():
                if key not in IGNORE_KEYS: collect(item)
    collect(view)
    return {'meIndex': me, 'playerIds': player_ids, 'cardIds': card_ids, 'cards': cards}


def _num(x: Any) -> float:
    try:
        n = float(x)
        return n if math.isfinite(n) else 0.0
    except (TypeError, ValueError): return 0.0


def encode_state(view: dict, player_id: str, architecture: str = 'entity-v5') -> tuple[np.ndarray, dict]:
    if architecture not in ('entity-v1', 'entity-v2', 'entity-v3', 'entity-v4', 'entity-v5'):
        raise ValueError(f'Unsupported Python architecture: {architecture}')
    includes_public = architecture == 'entity-v5'
    includes_city_ids = architecture in ('entity-v4', 'entity-v5')
    includes_hand = architecture in ('entity-v3', 'entity-v4', 'entity-v5')
    player_width = 88 if includes_city_ids else 80
    hand_start = 736 if includes_city_ids else 672
    state_size = 838 if includes_public else 766 if includes_city_ids else 702 if includes_hand else 672
    vec = np.zeros(state_size, dtype=np.float32)
    ctx = observation_context(view, player_id)
    players = view.get('players') or []
    n = len(players); me = ctx['meIndex']; count = min(8, n)
    rel = lambda value: 0 if value is None or value < 0 or not n else (value-me+n) % n
    turn=view.get('turn') or {}; draft=view.get('draft') or {}; reaction=view.get('reaction') or {}; confirm=view.get('roundConfirm') or {}
    active = turn.get('playerIdx', reaction.get('playerIdx', next((i for i,p in enumerate(players) if p.get('id')==draft.get('currentPlayer')), -1)))
    phase=PHASE_CODES.get(view.get('phase'),6); pending=turn.get('pending') or {}
    vals=[11,n/8,phase/6,_num(view.get('round'))/100,rel(active)/8,_num(view.get('endDistricts', (view.get('config') or {}).get('endDistricts',8)))/12,
      0 if view.get('firstToFinish') is None or view.get('firstToFinish')<0 else (rel(view['firstToFinish'])+1)/9,
      _num(view.get('deckCount'))/100,_num(view.get('discardCount'))/100,len(view.get('charDeck') or [])/8,_num(view.get('callIdx'))/16,
      _num(draft.get('stepIdx'))/32,_num(draft.get('totalSteps'))/32,
      (rel(next((i for i,p in enumerate(players) if p.get('id')==draft.get('currentPlayer')),-1))+1)/9 if draft.get('currentPlayer') else 0,
      0 if reaction.get('playerIdx') is None else (rel(reaction['playerIdx'])+1)/9,
      sum(bool(x) for x in confirm.get('confirmed',[]))/8,
      (rel(pending['targetIdx'])+1)/9 if pending.get('targetIdx') is not None else 0,
      (rel(pending['fromCrownIdx'])+1)/9 if pending.get('fromCrownIdx') is not None else 0,
      PENDING_CODES.get(pending.get('kind'),0)/34,TURN_PHASE_CODES.get(turn.get('phase'),4)/4,
      _num(view.get('turnsCompleted'))/100,*[float(bool(turn.get(k))) for k in ('takenResources','incomeTaken','monkExtraTaken','abilityUsed','usedLab','usedSmithy','usedMuseum','bonusDone')],
      _num(pending.get('amount') or pending.get('count'))/8,_num(turn.get('builds'))/4,_num(turn.get('spentOnBuild'))/20]
    vec[:32]=vals
    vec[0] = {'entity-v1': 8, 'entity-v2': 8, 'entity-v3': 9, 'entity-v4': 10, 'entity-v5': 11}[architecture]
    for r in range(8):
      p=players[(me+r)%n] if r<count and n else None
      if not p: continue
      b=32+r*player_width; city=p.get('city') or []; colors={c.get('color') for c in city}
      features=[_num(p.get('gold'))/20,_num(p.get('handCount',len(p.get('hand') or [])))/20,len(city)/max(1,_num(view.get('endDistricts',(view.get('config') or {}).get('endDistricts',8)))),
        float(bool(p.get('hasCrown'))),float((me+r)%n==active),float(bool(p.get('hasChosen'))),float(bool(p.get('draftComplete'))),
        0 if p.get('revealedCharNum') is None else (_num(p['revealedCharNum'])+1)/21,len(p.get('played') or [])/3,
        sum(_num(c.get('scoreValue') or c.get('cost')) for c in city)/100,sum(_num(c.get('cost')) for c in city)/100,len(colors)/5,
        sum(bool(c.get('purpleEffect')) for c in city)/10,sum(_num(c.get('museumCount')) for c in city)/10,sum(_num(c.get('beautified')) for c in city)/10,
        len(p.get('chars') or [])/3,float(p.get('connected') is not False),float(bool(p.get('isBot'))),0,
        _num(pending.get('count'))/8 if (me+r)%n==active and pending.get('count') else 0]
      vec[b:b+20]=features
      rv=_num(p.get('revealedCharNum'))
      if 1<=rv<=9: vec[b+19+int(rv)]=1
      role=p.get('revealedCharId')
      if role in ROLE_IDS: vec[b+29+ROLE_IDS.index(role)]=1
      for i,c in enumerate(city[:8]):
        slot_width=4 if includes_city_ids else 3
        s=b+56+i*slot_width; ident=CARD_INDEX.get(c.get('en'))
        vec[s:s+3]=[min(1,max(0,_num(c.get('cost'))/8)),(COLOR_INDEX.get(c.get('color'),-1)+1)/5 if c.get('color') in COLOR_INDEX else 0,min(1,max(0,_num(c.get('scoreValue') or c.get('cost'))/10))]
        if includes_city_ids and ident: vec[s+3]=ident[0]+1
    hand=(players[me].get('hand') or []) if n else []
    if includes_hand:
      for card in hand:
        entry=CARD_INDEX.get(card.get('en'))
        if entry: vec[hand_start+entry[0]] += 1/entry[1]
    if not includes_public:
      return vec,ctx
    start=766; effects=view.get('effects') or {}
    def mark(roles, off):
      for role in roles or []:
        rid=role if isinstance(role,str) else (role or {}).get('id')
        if rid in ROLE_IDS: vec[start+off+ROLE_IDS.index(rid)]=1
    mark(view.get('charDeck'),0); mark((view.get('removed') or {}).get('faceUp'),27)
    for off,value in ((54,effects.get('assassinated')),(55,effects.get('thief')),(56,effects.get('bewitched'))):
      if isinstance(value,int) and 1<=value<=9: vec[start+off]=value/9
    vec[start+57]=_num(effects.get('taxCollectorGold'))/20
    own=players[me] if n else {}; second=((own.get('chars') or [{}]*2)[1] or {}).get('id') if len(own.get('chars') or [])>1 else None
    if second in ROLE_IDS: vec[start+58]=(ROLE_IDS.index(second)+1)/len(ROLE_IDS)
    def mask(nums): return sum(1<<(v-1) for v in (nums or []) if isinstance(v,int) and 1<=v<=9)/512
    mag=effects.get('magistrate') or {}; black=effects.get('blackmailer') or {}
    vec[start+59]=mask(mag.get('nums')); vec[start+60]=mask(black.get('nums')); vec[start+61]=mask(black.get('done'))
    vec[start+63]=mask([x.get('num') for x in black.get('revealed',[]) if x and x.get('isReal')])
    if pending.get('kind')=='magician_redraw':
      vec[start+64]=_num(pending.get('cursor'))/20; vec[start+65]=len(pending.get('selected') or [])/20
      low=high=0
      for uid in pending.get('selected') or []:
        card=next((c for c in hand if c.get('uid')==uid),None); ident=CARD_INDEX.get(card.get('en')) if card else None
        if ident:
          if ident[0]<15: low |= 1<<ident[0]
          else: high |= 1<<(ident[0]-15)
      vec[start+66]=low/32768; vec[start+67]=high/32768
    return vec,ctx


def encode_action(action: dict, context: dict, encoding_version: int = ACTION_ENCODING_VERSION) -> np.ndarray:
    v=np.zeros(ACTION_SIZE,dtype=np.float32); v[0]=encoding_version; action=action or {}
    typ=action.get('type','')
    if typ in ACTION_TYPES: v[1+ACTION_TYPES.index(typ)]=1
    rel=context.get('playerIds',{}).get(action.get('target'))
    target_offset = 124 if encoding_version >= 7 else 42
    if rel is not None and 0<=rel<8: v[target_offset+rel]=1
    role=str(action.get('charId',action.get('name','')) or '')
    num=_num(action.get('num')) or ROLE_NUM.get(role)
    if num: v[50+int(num)-1]=1
    if role in ROLE_IDS: v[68+ROLE_IDS.index(role)]=1
    mode=str(action.get('mode',action.get('effect',('use' if action.get('use') else 'skip') if action.get('use') is not None else '')) or '')
    modes=['gold','cards','card','swap','redraw','use','skip','take','destroy']
    if mode in modes: v[59+modes.index(mode)]=1
    card=context.get('cards',{}).get(action.get('uid')); identity=CARD_INDEX.get(card.get('en')) if card else None
    if encoding_version>=8 and identity: v[132+identity[0]]=1
    if card:
      v[105]=min(1,max(0,_num(card.get('cost'))/8)); col=card.get('color')
      if col in COLOR_INDEX: v[100+COLOR_INDEX[col]]=1
      v[106]=min(1,max(0,_num(card.get('scoreValue') or card.get('cost'))/10))
    if action.get('color') in COLOR_INDEX: v[95+COLOR_INDEX[action['color']]]=1
    for idx,key,den in ((107,'num',9),(108,'gold',20),(109,'cards',8)):
      if action.get(key) is not None: v[idx]=max(0,min(1,_num(action[key])/den))
    if action.get('use') is not None: v[110]=float(bool(action['use']))
    v[111]=float(bool(action.get('uid'))); v[112]=float(bool(action.get('secondaryUid') or action.get('discardUid') or action.get('cardUid')))
    selected=action.get('uids') if isinstance(action.get('uids'),list) else []; v[113]=min(1,len(selected)/8)
    def uid_num(uid):
      m=re.search(r'(\d+)$',str(uid or '')); return min(1,int(m.group(1))/64) if m else 0
    v[114]=uid_num(action.get('uid')); v[115]=uid_num(action.get('secondaryUid') or action.get('discardUid') or action.get('cardUid'))
    for i,uid in enumerate(selected[:8]): v[116+i]=uid_num(uid)
    norm=float(np.linalg.norm(v))
    if norm>1: v/=norm
    return v
