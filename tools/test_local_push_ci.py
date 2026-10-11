"""Verify normal push, dirty-worktree isolation and remote divergence with real Git."""
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_push_ci import push_main


class PushTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        if not self.root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError('Unexpected temporary test directory')
        self.addCleanup(self.temp.cleanup)
        self.gitexe = shutil.which('git')
        self.repo = self.root / 'repo'
        self.remote = self.root / 'remote.git'
        self.git('init', '-b', 'main', str(self.repo))
        self.git('-C', str(self.repo), 'config', 'user.name', 'Test')
        self.git('-C', str(self.repo), 'config', 'user.email', 'test@example.com')
        (self.repo / 'file.txt').write_text('base')
        self.commit('base')
        self.git('clone', '--bare', str(self.repo), str(self.remote))
        self.git('-C', str(self.repo), 'remote', 'add', 'origin', str(self.remote))
        self.cfg = dict(git=self.gitexe, repository=str(self.repo), target=str(self.remote))

    def git(self, *args):
        result = subprocess.run([self.gitexe, *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def commit(self, message):
        self.git('-C', str(self.repo), 'add', 'file.txt')
        self.git('-C', str(self.repo), 'commit', '-m', message)

    def test_push_then_no_change(self):
        (self.repo / 'file.txt').write_text('update')
        self.commit('update')
        self.assertEqual(push_main(self.cfg, io.StringIO())['result'], 'pushed')
        self.assertEqual(push_main(self.cfg, io.StringIO())['result'], 'up_to_date')

    def test_dirty_other_branch_only_pushes_main(self):
        (self.repo / 'file.txt').write_text('main update')
        self.commit('main update')
        main = self.git('-C', str(self.repo), 'rev-parse', 'main')
        self.git('-C', str(self.repo), 'checkout', '-b', 'development')
        (self.repo / 'file.txt').write_text('development update')
        self.commit('development update')
        (self.repo / 'file.txt').write_text('uncommitted')
        (self.repo / 'secret.txt').write_text('untracked')
        push_main(self.cfg, io.StringIO())
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'main'), main)
        self.assertEqual(self.git('-C', str(self.repo), 'branch', '--show-current'), 'development')
        self.assertEqual((self.repo / 'file.txt').read_text(), 'uncommitted')
        self.assertEqual(self.git('--git-dir', str(self.remote), 'ls-tree', '-r', '--name-only', 'main'), 'file.txt')

    def test_remote_ahead_rejects_without_overwrite(self):
        (self.repo / 'file.txt').write_text('remote update')
        self.commit('remote update')
        self.git('-C', str(self.repo), 'push', 'origin', 'main')
        remote = self.git('--git-dir', str(self.remote), 'rev-parse', 'main')
        self.git('-C', str(self.repo), 'branch', '-m', 'saved')
        self.git('-C', str(self.repo), 'branch', 'main', 'HEAD~1')
        with self.assertRaisesRegex(RuntimeError, 'push failed'):
            push_main(self.cfg, io.StringIO())
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'main'), remote)


if __name__ == '__main__':
    unittest.main()
