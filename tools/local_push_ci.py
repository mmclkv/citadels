"""Publish existing local main commits to GitHub without changing the worktree."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import traceback


def push_main(config, log):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never',
               GCM_GUI_PROMPT='false', PYTHONUTF8='1')
    def git(*args):
        command = [config['git'], '-C', config['repository'], *args]
        log.write('$ ' + subprocess.list2cmdline(command) + '\n')
        log.flush()
        result = subprocess.run(command, env=env, capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=300,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        log.write(result.stdout + result.stderr)
        log.flush()
        if result.returncode:
            raise RuntimeError(f'Git {args[0]} failed (exit {result.returncode}): '
                               + (result.stderr or result.stdout).strip()[-2000:])
        return result.stdout.strip()
    for args in [('remote', 'get-url', 'origin'), ('remote', 'get-url', '--push', 'origin')]:
        if git(*args) != config['target']:
            raise RuntimeError('Origin differs from the configured GitHub repository')
    # Snapshot only main, even if the user is editing or has checked out another branch.
    commit = git('rev-parse', '--verify', 'refs/heads/main^{commit}')
    remote_commit = git('ls-remote', '--exit-code', 'origin', 'refs/heads/main').split()[0]
    git('push', 'origin', commit + ':refs/heads/main')
    return dict(result='up_to_date' if commit == remote_commit else 'pushed',
                local_commit=commit, previous_remote_commit=remote_commit,
                remote_commit=commit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    config = json.loads(parser.parse_args().config.read_text(encoding='utf-8-sig'))
    state = Path(config['state']).resolve()
    state.mkdir(parents=True, exist_ok=True)
    logs = state / 'logs'
    logs.mkdir(exist_ok=True)
    with (state / 'run.lock').open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = datetime.now(timezone.utc)
        path = logs / (started.strftime('%Y%m%dT%H%M%S%fZ') + '.log')
        status = dict(result='running', started_at=started.isoformat(), log=str(path))
        statuspath = state / 'last-run.json'
        statuspath.write_text(json.dumps(status, indent=2), encoding='utf-8')
        code = 0
        with path.open('w', encoding='utf-8', buffering=1) as log:
            try:
                status.update(push_main(config, log))
            except Exception as error:
                traceback.print_exc(file=log)
                status.update(result='failed', error=str(error))
                code = 1
        status['finished_at'] = datetime.now(timezone.utc).isoformat()
        statuspath.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')
        if code == 0:
            (state / 'last-success.json').write_text(json.dumps(status, indent=2), encoding='utf-8')
        for old in sorted(logs.glob('*.log'))[:-180]:
            old.unlink()
        return code


if __name__ == '__main__':
    raise SystemExit(main())
