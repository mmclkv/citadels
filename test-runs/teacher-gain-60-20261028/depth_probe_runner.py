"""Instrument a COPY of native search; never change production search code."""
from pathlib import Path
import sys,os,shutil,json,subprocess
os.environ['OMP_NUM_THREADS']=os.environ['MKL_NUM_THREADS']=os.environ['OPENBLAS_NUM_THREADS']='1'
ROOT=Path(r'D:\Users\Jiaming Qiu\citadels');sys.path.insert(0,str(ROOT))
OUT=Path(r'C:\Users\Jiaming Qiu\citadels\tmp\search-depth-diagnosis-20261028');NATIVE=OUT/'native'
NATIVE.mkdir(parents=True,exist_ok=True)
for p in (ROOT/'native').iterdir():
    if p.suffix in ('.hpp','.cpp'):shutil.copyfile(p,NATIVE/p.name)
# Reproduce the frozen arena encoder (public difficulty was added afterwards).
p=NATIVE/'state_features.hpp';s=p.read_text(encoding='utf8');s=s.replace('    features[base + 18] = encoding_version >= 16 && p.is_bot && p.bot_type == "npc"\n        ? (p.bot_level == "hard" ? 1.0f : p.bot_level == "easy" ? 1.0f/3.0f : 2.0f/3.0f) : 0.0f;','    features[base + 18] = 0.0f;');p.write_text(s,encoding='utf8')
p=NATIVE/'mcts_core.hpp';s=p.read_text(encoding='utf8');s=s.replace('    size_t retained_nodes = 0;', '    size_t retained_nodes = 0;\n    std::array<double,6> diagnostic{};')
head,tail=s.split('class BatchedMcts',1)
tail=tail.replace('states.push_back(std::move(state)); players.push_back(node->player);',
    'record_leaf(path, node, state.round-seed_state.round);\n              states.push_back(std::move(state)); players.push_back(node->player);')
tail=tail.replace('record_leaf(path, node, state.round-seed_state.round);',
                  'record_leaf(paths.back(), node, state.round-seed_state.round);',1)
tail=tail.replace('  void expand(Node& node, const State& state) {', '''  void record_leaf(const std::vector<Node*>& path, const Node* node, int rounds) {
    diagnostic_[0] += 1;
    diagnostic_[1] += path.size()-1;
    diagnostic_[2] += node->actions.size()==1;
    diagnostic_[3] += node->player!=root_player_;
    diagnostic_[4] += rounds;
    diagnostic_[5] = std::max(diagnostic_[5],double(path.size()-1));
  }
  void expand(Node& node, const State& state) {''')
tail=tail.replace('    output.expansions = expansions_;','    output.expansions = expansions_;\n    output.diagnostic = diagnostic_;')
tail=tail.replace('  int expansions_ = 0;', '  int expansions_ = 0;\n  std::array<double,6> diagnostic_{};')
p.write_text(head+'class BatchedMcts'+tail,encoding='utf8')
p=NATIVE/'mcts_worker.cpp';s=p.read_text(encoding='utf8')
s=s.replace('      size_t particles_used = 0;', '      std::array<double,6> diagnostic{};\n      size_t particles_used = 0;')
s=s.replace('        root_value = result.value;', '        diagnostic = result.diagnostic;\n        root_value = result.value;')
s=s.replace('<< ",\\\"expansions\\\":" << expansions', '''<< ",\\\"expansions\\\":" << expansions
                << ",\\\"diagnostic\\\":[" << diagnostic[0] << ',' << diagnostic[1] << ',' << diagnostic[2] << ',' << diagnostic[3] << ',' << diagnostic[4] << ',' << diagnostic[5] << ']' ''')
p.write_text(s,encoding='utf8')
import torch
torch.set_num_threads(1)
from python_backend import native_worker_manager as builds
builds.NATIVE_DIR=NATIVE;builds.ROOT=OUT
manager=builds.NativeWorkerManager(log=lambda m:print(m,flush=True))
compiler,env,devcmd=manager._compiler_environment(require_msvc=True)
binary=NATIVE/'depth-probe.exe'
manager._build(compiler,env,Path(torch.__file__).parent,devcmd,destination=binary)
from python_backend.native_worker import NativeMctsWorker
from python_backend.game_engine_worker import GameEngineWorker
from python_backend import cards
engine=GameEngineWorker(ROOT/'native/game_engine-7b27a352ca0e.exe');worker=NativeMctsWorker(binary)
rows=[]
try:
 for n in (4,8):
    game=f'depth-{n}';engine.create_game({'seed':20261028+n,'charSetMode':'random','initialCrownSeat':0,'endDistricts':8,'startingHand':4,'startingGold':2,
        'catalog':cards._catalog,'seats':[{'id':f'p{i}','isBot':True,'botType':'npc','botLevel':'hard'} for i in range(n)]},game)
    stages=set()
    for step in range(500):
        cur=engine.current(game)
        if cur.get('gameOver'):break
        d=engine.decision(game);state=d['state'];actor=d['playerId'];idx=next(i for i,p in enumerate(state['players']) if p['id']==actor)
        progress=max(len(p['city']) for p in state['players']);stage='early' if progress<3 else 'middle' if progress<6 else 'late'
        if stage not in stages and len(d['actions'])>1 and state.get('phase')=='action':
            stages.add(stage);state['players'][idx]['botType']='neural'
            engine.load_game(state,game);d=engine.decision(game)
            sample=worker.determinize(state=d['state'],player_id=actor,count=8,seed=17,belief=False)
            for sims in (500,2000):
                result=worker.search(state=sample['particles'][0],particles=sample['particles'][1:],root_player_id=actor,legal_actions=d['actions'],particle_weights=sample['weights'],
                    model_path=str(ROOT/'test-runs/teacher-gain-60-20261028/model.bin'),model_version=1,profile='fast',architecture='entity-v6',device='cpu',simulations=sims,max_depth=700,
                    c_puct=1,dirichlet_alpha=0,dirichlet_epsilon=0,seed=31,batch_size=32,action_encoding_version=12,progressive_particles=True,root_belief=False)
                diag=result['diagnostic'];row={'players':n,'stage':stage,'round':state['round'],'simulations':sims,'leaves':diag[0],
                    'meanDepth':diag[1]/max(1,diag[0]),'forcedLeafFraction':diag[2]/max(1,diag[0]),'opponentLeafFraction':diag[3]/max(1,diag[0]),
                    'meanRoundAdvance':diag[4]/max(1,diag[0]),'maxDepth':diag[5],'particles':result['particlesUsed']}
                rows.append(row);print(json.dumps(row),flush=True)
            state['players'][idx]['botType']='npc';engine.load_game(state,game)
        action=engine.decide_npc(game_id=game,player_id=actor,seed=113+step,heuristic_mcts={'enabled':False})
        engine.apply(game_id=game,player_id=actor,action=action,return_state=False)
    if len(stages)!=3:print('Missing stage',n,stages,flush=True)
finally:engine.close();worker.close()
(OUT/'report.json').write_text(json.dumps(rows,indent=2),encoding='utf8')
