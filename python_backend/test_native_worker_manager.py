from __future__ import annotations

import builtins
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend import native_worker_manager as manager_module  # noqa: E402


class _Process:
    pid = 12345

    def poll(self):
        return None


class _GameWorker:
    def __init__(self, *_args, **_kwargs):
        self.executable = Path("game_engine.exe")
        self.process = _Process()
        self.closed = False

    def close(self):
        self.closed = True


class NativeWorkerManagerTests(unittest.TestCase):
    def test_neural_mode_selects_msvc_when_mingw_is_first(self):
        manager = manager_module.NativeWorkerManager(lambda _: None)
        targets = {'mingw-clang': 'x86_64-w64-windows-gnu', 'msvc-clang': 'x86_64-pc-windows-msvc'}
        with (mock.patch.dict(manager_module.os.environ, {'CITADELS_CLANGXX': ''}),
              mock.patch.object(manager, '_compiler_candidates', return_value=list(targets)),
              mock.patch.object(manager, '_compiler_target', side_effect=targets.__getitem__)):
            self.assertEqual(manager._select_compiler(require_msvc=True), 'msvc-clang')
            self.assertEqual(manager._select_compiler(), 'mingw-clang')

    def test_explicit_compiler_choice_is_not_silently_overridden(self):
        manager = manager_module.NativeWorkerManager(lambda _: None)
        with (mock.patch.dict(manager_module.os.environ, {'CITADELS_CLANGXX': 'custom-clang'}),
              mock.patch.object(manager_module.shutil, 'which', return_value=None),
              mock.patch.object(manager, '_compiler_candidates') as discover,
              mock.patch.object(manager, '_compiler_target', return_value='x86_64-w64-windows-gnu')):
            with self.assertRaisesRegex(RuntimeError, 'CITADELS_CLANGXX'):
                manager._select_compiler(require_msvc=True)
            self.assertEqual(manager._select_compiler(), 'custom-clang')
            discover.assert_not_called()

    def test_missing_or_unusable_msvc_reports_installation_guidance(self):
        manager = manager_module.NativeWorkerManager(lambda _: None)
        with (mock.patch.dict(manager_module.os.environ, {'CITADELS_CLANGXX': ''}),
              mock.patch.object(manager, '_compiler_candidates', return_value=['bad', 'mingw']),
              mock.patch.object(manager, '_compiler_target', side_effect=[OSError('cannot execute'), 'windows-gnu'])):
            with self.assertRaisesRegex(RuntimeError, 'Build Tools'):
                manager._select_compiler(require_msvc=True)

    def test_msvc_command_preserves_cmd_quotes(self):
        command = manager_module._msvc_build_command(
            "C:/Program Files/VS/VsDevCmd.bat",
            ["C:/Program Files/LLVM/bin/clang++.exe", "C:/User Name/game.cpp"])
        self.assertIsInstance(command, str)
        self.assertTrue(command.startswith('cmd.exe /d /s /c "call "'))
        self.assertIn('&& "C:/Program Files/LLVM/bin/clang++.exe"', command)
        self.assertIn('"C:/User Name/game.cpp"', command)
        self.assertNotIn('\\"', command)

    def test_game_only_mode_does_not_import_torch_or_start_mcts(self):
        logs = []
        manager = manager_module.NativeWorkerManager(logs.append)
        real_import = builtins.__import__

        def import_without_torch(name, *args, **kwargs):
            if name == "torch":
                raise AssertionError("torch should not be imported in game-only mode")
            return real_import(name, *args, **kwargs)

        with (mock.patch.object(manager, "_compiler_environment",
                                return_value=("clang++", {}, None)),
              mock.patch.object(manager, "_compiler_target",
                                return_value="x86_64-w64-windows-gnu"),
              mock.patch.object(manager, "_build_game_engine", return_value="game_engine.exe"),
              mock.patch.object(manager_module, "GameEngineWorker", _GameWorker),
              mock.patch("builtins.__import__", side_effect=import_without_torch)):
            manager.start(skip_neural_policy=True)

        self.assertTrue(manager.running)
        self.assertIsNone(manager.worker)
        self.assertIsNone(manager.process)
        self.assertTrue(any("跳过策略神经网络 worker" in message for message in logs))

        game_worker = manager.game_worker
        manager.close()
        self.assertTrue(game_worker.closed)
        self.assertFalse(manager.running)


if __name__ == "__main__":
    unittest.main()
