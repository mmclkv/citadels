"""Bounded recent games plus stratified long-term game reservoirs."""
from collections import deque
import numpy as np

def opponent_stratum(composition):
    if not composition: return (0,'unknown')
    counts = {'current':max(0,composition['main']-1),
              'history':composition['historical'],'heuristic':composition['heuristic']}
    largest = max(counts.values())
    winners = [name for name, count in counts.items() if count == largest]
    return (composition['players'], winners[0] if len(winners)==1 else 'mixed')

class OpponentReplayBuffer:
    def __init__(self,max_games,seed=1):
        self.max_games=max(0,int(max_games))
        self.recent_capacity=(self.max_games+1)//2
        self.archive_capacity=self.max_games//2
        self.recent=deque()
        self.archive={}
        self.seen={}
        self.rng=np.random.default_rng(seed)

    @staticmethod
    def _bytes(rows):
        return sum(int(value.nbytes) for row in rows for key in ('state','actions','pi','reward','valueMask')
                   if isinstance(value:=row.get(key),np.ndarray))
    @property
    def entries(self):return list(self.recent)+[game for bucket in self.archive.values() for game in bucket]
    @property
    def game_count(self):return len(self.entries)
    @property
    def samples(self):return sum(len(game[1]) for game in self.entries)
    @property
    def bytes(self):return sum(game[2] for game in self.entries)
    @property
    def archive_games(self):return sum(map(len,self.archive.values()))

    def add_game(self,rows,composition=None):
        if not rows or not self.max_games:return False
        self.recent.append((opponent_stratum(composition),rows,self._bytes(rows)))
        if len(self.recent)>self.recent_capacity:
            game=self.recent.popleft()
            if self.archive_capacity:self._archive(game)
        return True

    def _archive(self,game):
        key=game[0]
        self.seen[key]=self.seen.get(key,0)+1
        self.archive.setdefault(key,[])
        keys=sorted(self.archive)
        quotas={k:self.archive_capacity//len(keys)+int(i<self.archive_capacity%len(keys)) for i,k in enumerate(keys)}
        for k,bucket in self.archive.items():
            quota=quotas[k]
            if len(bucket)>quota:
                selected=self.rng.choice(len(bucket),quota,replace=False)
                self.archive[k]=[bucket[int(i)] for i in selected]
        bucket=self.archive[key];quota=quotas[key]
        if len(bucket)<quota:bucket.append(game)
        elif quota:
            index=int(self.rng.integers(self.seen[key]))
            if index<quota:bucket[index]=game

    @staticmethod
    def _sample(entries,count,rng):
        # Round-robin strata and games; long games do not get extra turns.
        groups={}
        for key,rows,_ in entries:
            groups.setdefault(key,[]).append((rows,deque(int(i) for i in rng.permutation(len(rows)))))
        for key,games in groups.items():
            rng.shuffle(games);groups[key]=deque(games)
        result=[]
        while groups and len(result)<count:
            keys=list(groups);rng.shuffle(keys)
            for key in keys:
                games=groups[key];rows,indices=games.popleft()
                result.append(rows[indices.popleft()])
                if indices:games.append((rows,indices))
                if not games:del groups[key]
                if len(result)==count:break
        return result

    def sample(self,limit,rng):
        count=min(max(0,int(limit)),self.samples)
        archived=[game for bucket in self.archive.values() for game in bucket]
        old_count=min(count//2,sum(len(g[1]) for g in archived))
        recent_count=min(count-old_count,sum(len(g[1]) for g in self.recent))
        old_count=count-recent_count
        result=self._sample(list(self.recent),recent_count,rng)+self._sample(archived,old_count,rng)
        rng.shuffle(result)
        return result
