"""Exercise real Git releases, main advancing independently, and rollback."""
from __future__ import annotations

import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from python_backend.versioning import git, release_commit, require_stable, version_info
from tools.release import checkout_release, create_tag


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="citadels-release-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.repo = self.directory / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.name", "Release Test")
        git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "VERSION").write_text("0.1.0\n", encoding="utf-8")
        (self.repo / "game.txt").write_text("original game", encoding="utf-8")
        self.commit("baseline")

    def commit(self, message):
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-m", message)

    def test_main_updates_do_not_change_stable_and_old_versions_can_be_redeployed(self):
        tag = create_tag(self.repo, "0.1.0")
        first = checkout_release(self.repo, tag, self.directory / "production-v1")
        require_stable(first)
        self.assertEqual(first["version"], "0.1.0")
        # Even the tagged commit on main is a development checkout.
        self.assertEqual(version_info(self.repo)["channel"], "development")
        (self.repo / "VERSION").write_text("0.2.0\n", encoding="utf-8")
        (self.repo / "game.txt").write_text("new game", encoding="utf-8")
        self.commit("continue development")
        self.assertEqual(version_info(self.directory / "production-v1"), first)
        self.assertIn("0.2.0-dev+g", version_info(self.repo)["version"])
        create_tag(self.repo, "0.2.0")
        second = checkout_release(self.repo, "v0.2.0", self.directory / "production-v2")
        self.assertNotEqual(first["commit"], second["commit"])
        rolled_back = checkout_release(self.repo, "v0.1.0", self.directory / "rollback")
        self.assertEqual(rolled_back, first)
        self.assertEqual((self.directory / "rollback/game.txt").read_text(), "original game")

    def test_dirty_release_and_missing_tag_fail_closed(self):
        create_tag(self.repo, "0.1.0")
        path = self.directory / "production"
        checkout_release(self.repo, "v0.1.0", path)
        (path / "game.txt").write_text("local hotfix", encoding="utf-8")
        info = version_info(path)
        self.assertTrue(info["dirty"])
        with self.assertRaises(ValueError):
            require_stable(info)
        git(path, "tag", "-d", "v0.1.0")
        self.assertEqual(version_info(path)["channel"], "development")

    def test_reject_overwrite_uncommitted_version_and_nonrelease_refs(self):
        create_tag(self.repo, "0.1.0")
        with self.assertRaises(ValueError):
            create_tag(self.repo, "0.1.0")
        with self.assertRaises(ValueError):
            checkout_release(self.repo, "main", self.directory / "invalid")
        with self.assertRaises(ValueError):
            checkout_release(self.repo, "v0.1.0", self.repo)
        (self.repo / "VERSION").write_text("0.2.0\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            create_tag(self.repo, "0.2.0")
        self.assertEqual(git(self.repo, "tag", "--list"), "v0.1.0")

    def test_lightweight_or_mismatched_tags_cannot_be_stable(self):
        git(self.repo, "tag", "v0.1.0")
        with self.assertRaises(ValueError):
            release_commit(self.repo, "v0.1.0")
        git(self.repo, "tag", "-a", "v9.0.0", "-m", "wrong version")
        with self.assertRaises(ValueError):
            release_commit(self.repo, "v9.0.0")
        git(self.repo, "checkout", "--detach", "HEAD")
        with self.assertRaises(ValueError):
            require_stable(version_info(self.repo))

    def test_source_without_git_is_development(self):
        directory = self.directory / "source"
        directory.mkdir()
        (directory / "VERSION").write_text("0.1.0\n", encoding="utf-8")
        self.assertEqual(version_info(directory)["version"], "0.1.0-dev+unknown")

    def test_stable_guard_runs_before_workers(self):
        from python_backend.server import serve
        with patch("python_backend.server.version_info", return_value=version_info(self.repo)), \
             patch("python_backend.server.NativeWorkerManager") as workers:
            with self.assertRaises(ValueError):
                asyncio.run(serve("127.0.0.1", 0, stable_only=True))
            workers.assert_not_called()

    def test_shared_training_directory_survives_code_version_changes(self):
        from python_backend.training_runtime import TrainingManager
        shared = self.directory / "shared-training"
        shared.mkdir()
        checkpoint = shared / "checkpoint-000123.json.gz"
        checkpoint.write_bytes(b"persistent checkpoint")
        with patch.dict("os.environ", {"CITADELS_TRAINING_DATA_DIR": str(shared)}):
            first = TrainingManager()
            second = TrainingManager()
            self.assertEqual(first.data_dir, shared)
            self.assertEqual(second.data_dir, shared)
            explicit = TrainingManager(self.directory / "explicit")
            self.assertEqual(explicit.data_dir, self.directory / "explicit")
        self.assertEqual(checkpoint.read_bytes(), b"persistent checkpoint")


if __name__ == "__main__":
    unittest.main()
