"""Check publishable Python sources, including the staged Git tree."""
import subprocess
import sys
import types
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PythonSyntaxTests(unittest.TestCase):
    def test_staged_server_import_and_effect_log_branches(self):
        source = subprocess.check_output(['git', 'show', ':python_backend/server.py'], cwd=ROOT)
        name = 'python_backend._staged_server_syntax'
        module = types.ModuleType(name)
        module.__package__ = 'python_backend'
        module.__file__ = str(ROOT / 'python_backend/server.py')
        sys.modules[name] = module
        try:
            exec(compile(source, module.__file__, 'exec'), module.__dict__)
            server = module.PythonServer
            state = {'turn': {'playerIdx': 0, 'pending': {'kind': 'blackmailer_threat', 'signed': False}},
                     'reaction': {'kind': 'blackmailer', 'playerIdx': 1},
                     'players': [{'id': 'p0', 'name': '目标', 'gold': 2},
                                 {'id': 'p1', 'name': '勒索者', 'gold': 3}]}
            text = server._game_action_log_text(state, {'type': 'reaction', 'name': 'use'}, state)
            self.assertIn('假威胁', text)
            self.assertIn('目标', text)
            self.assertIn('皇帝', server._emperor_take_text(state, {'name': 'gold'}))
        finally:
            sys.modules.pop(name, None)

    def test_tracked_working_sources_parse(self):
        paths = subprocess.check_output(['git', 'ls-files', '*.py'], cwd=ROOT, text=True).splitlines()
        self.assertTrue(paths)
        for path in paths:
            with self.subTest(path=path):
                if (ROOT / path).is_file():
                    compile((ROOT / path).read_bytes(), path, 'exec')

    def test_staged_sources_parse(self):
        # HEAD/working-tree differences must not hide a broken release. In
        # particular, helper functions must not split an existing branch.
        paths = subprocess.check_output(['git', 'ls-files', '*.py'], cwd=ROOT, text=True).splitlines()
        self.assertTrue(paths)
        for path in paths:
            with self.subTest(path=path):
                source = subprocess.check_output(['git', 'show', ':' + path], cwd=ROOT)
                compile(source, path, 'exec')


if __name__ == '__main__':
    unittest.main()
