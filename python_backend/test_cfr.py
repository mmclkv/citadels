"""CFR room migration, native training and real-game IPC integration checks."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from python_backend.cfr_runtime import ROOT, rules_contract
from python_backend.game_engine_worker import GameEngineWorker
from python_backend.rooms import RoomRegistry, lobby_view


class CfrConfigurationTests(unittest.TestCase):
    def test_single_bot_type_migrates_all_old_difficulties(self):
        for kind in ("npc", "npc-easy", "npc-normal", "npc-hard", "cfr"):
            room = RoomRegistry().create_room("Host", {"bots": 1, "botType": kind, "botLevel": "hard"})
            seat = lobby_view(room)["seats"][1]
            self.assertEqual(seat["botType"], "cfr")
            self.assertNotIn("botLevel", seat)
            self.assertNotIn("heuristicMcts", seat)

    def test_neural_and_agent_are_not_migrated(self):
        for kind in ("agent", "neural"):
            room = RoomRegistry().create_room("Host", {"bots": 1, "botType": kind})
            self.assertEqual(room["seats"][1]["botType"], kind)

    def test_sampler_passes_same_cfr_environment_to_its_game_process(self):
        from python_backend import training_runtime
        cfr_env = {"CITADELS_CFR_WORKER": "cfr_worker", "CITADELS_CFR_CONTRACT": "contract",
                   "CITADELS_CFR_POLICY": "policy.jsonl"}
        with (mock.patch.object(training_runtime, "_SAMPLER_GAME_WORKER", None),
              mock.patch.object(training_runtime, "_SERVER_GAME_WORKER", None),
              mock.patch.object(training_runtime, "GameEngineWorker") as constructor,
              mock.patch.object(training_runtime.atexit, "register")):
            training_runtime._game_worker({"gameEnginePath": "game_engine", "cfrEnvironment": cfr_env})
            environment = constructor.call_args.kwargs["env"]
            for key, value in cfr_env.items(): self.assertEqual(environment[key], value)


@unittest.skipUnless(os.environ.get("CITADELS_TEST_CFR_WORKER") and os.environ.get("CITADELS_TEST_GAME_ENGINE"),
                     "Set native CFR and game test executable paths")
class CfrNativeTests(unittest.TestCase):
    def setUp(self):
        self.environment = dict(os.environ, CITADELS_CFR_WORKER=os.environ["CITADELS_TEST_CFR_WORKER"],
                                CITADELS_CFR_CONTRACT=rules_contract())
        self.environment.pop("CITADELS_CFR_POLICY", None)
        self.catalog = json.loads((ROOT / "python_backend/catalog.json").read_text(encoding="utf-8"))

    def train(self, output: Path, iterations=1, resume="", max_steps=6000):
        request = {"mode": "train", "contract": rules_contract(), "catalog": self.catalog,
                   "iterations": iterations, "minPlayers": 4, "maxPlayers": 4,
                   "endDistricts": 4, "charSetMode": "random", "exploration": .6,
                   "maxSteps": max_steps, "saveEvery": 1, "seed": 11,
                   "output": str(output), "resume": str(resume)}
        result = subprocess.run([self.environment["CITADELS_CFR_WORKER"]],
                                input=json.dumps(request, ensure_ascii=False)+"\n", text=True,
                                encoding="utf-8", capture_output=True, env=self.environment, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses[-1]["t"], "cfr_done", responses)
        with output.open(encoding="utf-8") as stream:
            records = [json.loads(line) for line in stream]
        return records

    def test_training_checkpoint_and_deterministic_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            first = Path(folder)/"resume.jsonl"; whole = Path(folder)/"whole.jsonl"
            one = self.train(first)
            self.assertEqual(one[0]["episodes"], 4)
            self.assertTrue(any(any(x != 0 for x in record["regrets"]) for record in one[1:]))
            resumed = self.train(first, resume=first)
            uninterrupted = self.train(whole, iterations=2)
            self.assertEqual(resumed[0], uninterrupted[0])
            self.assertEqual({x["information"]: x for x in resumed[1:]},
                             {x["information"]: x for x in uninterrupted[1:]})
            self.assertFalse(list(first.parent.glob(first.name+".tmp-*")))

    def test_truncated_games_do_not_update_regrets(self):
        with tempfile.TemporaryDirectory() as folder:
            records = self.train(Path(folder)/"short.jsonl", max_steps=1)
            self.assertEqual(records[0]["episodes"], 0)
            self.assertTrue(all(all(x == 0 for x in r["regrets"]+r["strategy"]) for r in records[1:]))

    def test_untrained_room_reports_fallback_and_returns_legal_action(self):
        worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=self.environment)
        try:
            setup = {"catalog": self.catalog, "seed": 11, "endDistricts": 4, "charSetMode": "random",
                     "seats": [{"id": f"p{i}", "isBot": True, "botType": "cfr"} for i in range(5)]}
            before = worker.create_game(setup, "room")
            actor = worker.current("room")["playerId"]
            result = worker._request("npc", gameId="room", playerId=actor, seed=19)
            self.assertFalse(result["cfr"]["configured"])
            self.assertEqual(result["cfr"]["fallback"], "uniform-legal-actions")
            self.assertIn(result["action"], worker.legal_actions(game_id="room", player_id=actor)["actions"])
            self.assertEqual(before, worker.snapshot("room"))
            advanced = worker._request("advance_npcs", gameId="room", networkPlayerIds=[], seed=71,
                                       maxSteps=10000, maxRounds=1000, includeTrainingFeatures=False)
            self.assertTrue(advanced["gameOver"])
            self.assertEqual(advanced["cfr"]["hits"], 0)
            self.assertGreater(advanced["cfr"]["misses"], 0)
        finally:
            worker.close()

    def test_trained_policy_process_loads_and_contract_errors_are_not_hidden(self):
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder)/"policy.jsonl"; records = self.train(checkpoint)
            self.environment["CITADELS_CFR_POLICY"] = str(checkpoint)
            record = next(r for r in records[1:] if any(x > 0 for x in r["strategy"]))
            request = {"mode": "infer", "information": record["information"], "actions": record["actions"], "seed": 2}
            result = subprocess.run([self.environment["CITADELS_CFR_WORKER"]], input=json.dumps(request, ensure_ascii=False)+"\n",
                                    text=True, encoding="utf-8", capture_output=True, env=self.environment, timeout=30)
            response = json.loads(result.stdout)
            self.assertTrue(response["hit"] and response["configured"])
            self.environment["CITADELS_CFR_CONTRACT"] = "incompatible"
            result = subprocess.run([self.environment["CITADELS_CFR_WORKER"]], input=json.dumps(request, ensure_ascii=False)+"\n",
                                    text=True, encoding="utf-8", capture_output=True, env=self.environment, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["t"], "error")

    def test_uniform_policy_completes_two_to_eight_player_games(self):
        worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=self.environment)
        try:
            for players in range(2, 9):
                with self.subTest(players=players):
                    setup = {"catalog": self.catalog, "seed": 173+players, "endDistricts": 4,
                             "charSetMode": "random", "seats": [
                                 {"id": f"p{i}", "isBot": True, "botType": "cfr"} for i in range(players)]}
                    worker.create_game(setup, "game")
                    result = worker._request("advance_npcs", gameId="game", networkPlayerIds=[],
                                             seed=113, maxSteps=20000, maxRounds=1000,
                                             includeTrainingFeatures=False)
                    self.assertTrue(result["gameOver"])
                    worker.close_game("game")
        finally:
            worker.close()


if __name__ == "__main__":
    unittest.main()
