"""Immediate human-seat hosting, including cancellation of stale bot decisions."""

import asyncio
import copy
import unittest
from unittest import mock

from python_backend import test_server as transport
from python_backend.server import Client


class ManualHostingTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = transport.TransportTests.asyncSetUp
    asyncTearDown = transport.TransportTests.asyncTearDown


    async def setup_room(self, start=True):
        room = self.app.rooms.create_room('Host', {'playerCount': 2, 'bots': 1, 'autoHost': False})
        if start:
            transport._start_reference_room(self.app.rooms, room['id'], self.app.native_worker_manager.game_worker)
        client = Client(None)
        client.id, client.room_id = room['seats'][0]['id'], room['id']
        client.send = mock.AsyncMock()
        self.app.clients.add(client)
        return room, client


    async def test_toggle_and_native_snapshot(self):
        room, client = await self.setup_room()
        with mock.patch.object(self.app, '_schedule_bot') as schedule:
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
            schedule.assert_called_once_with(room)
            view = await self.app._state_for_client(room, client.id)
            self.assertTrue(view['hostingEnabled'])
            self.assertEqual(view['available']['actions'], [])
            player = room['state']['players'][0]
            self.assertEqual(player['botType'], 'npc')
            self.assertEqual(player['heuristicMcts'], {'timeBudgetMs': 10000})
            self.assertFalse(room['seats'][0]['isBot'])
            self.assertFalse(view['autoHostEnabled'])
            action = (await self.app._bot_available_actions(room['state'], client.id))['actions'][0]
            worker = self.app.native_worker_manager.game_worker
            original_apply = worker.apply
            def native_snapshot(**kwargs):
                state = copy.deepcopy(original_apply(**kwargs))
                state['players'][0]['isBot'] = False
                state['players'][0]['botType'] = 'neural'
                return state
            with mock.patch.object(worker, 'apply', side_effect=native_snapshot):
                self.assertTrue((await self.app._apply_game_action(room, client.id, action))['ok'])
            self.assertTrue(room['state']['players'][0]['isBot'])
            self.assertEqual(room['state']['players'][0]['botType'], 'npc')
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': False})
            self.assertFalse((await self.app._state_for_client(room, client.id))['hostingEnabled'])


    async def test_reject_outside_game_and_other_seats(self):
        room, client = await self.setup_room(start=False)
        with self.assertRaisesRegex(ValueError, '进行中'):
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
        transport._start_reference_room(self.app.rooms, room['id'], self.app.native_worker_manager.game_worker)
        client.id = room['seats'][1]['id']
        with self.assertRaisesRegex(ValueError, '自己的真人'):
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
        _, spectator = self.app.rooms.spectate_room(room['id'], 'Observer')
        client.id = spectator['id']
        with self.assertRaisesRegex(ValueError, '观战模式'):
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
        client.id = room['seats'][0]['id']
        room['state']['phase'] = 'gameover'
        with self.assertRaisesRegex(ValueError, '进行中'):
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})


    async def test_old_decision_rejected_after_off_on(self):
        room, client = await self.setup_room()
        with mock.patch.object(self.app, '_schedule_bot'):
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
            version = room['state']['players'][0]['hostingVersion']
            action = (await self.app._bot_available_actions(room['state'], client.id))['actions'][0]
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': False})
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
            with mock.patch.object(self.app.native_worker_manager.game_worker, 'apply') as apply:
                result = await self.app._apply_game_action(room, client.id, action, hosting_version=version)
                self.assertFalse(result['ok'])
                apply.assert_not_called()


    async def test_disabling_before_bot_task_runs_prevents_decision(self):
        room, client = await self.setup_room()
        await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
        task = room['botTask']
        await self.app._handle_message(client, {'t': 'setHosting', 'enabled': False})
        await task
        self.assertEqual(self.app.native_worker_manager.game_worker.npc_decisions, 0)
        self.assertFalse(room['state']['players'][0]['isBot'])

    async def test_disabling_while_deciding_discards_action(self):
        room, client = await self.setup_room()
        started, release = asyncio.Event(), asyncio.Event()
        original = self.app._bot_available_actions
        async def delayed(state, player_id):
            actions = await original(state, player_id)
            started.set()
            await release.wait()
            return actions
        with mock.patch.object(self.app, '_broadcast_state', new_callable=mock.AsyncMock), \
             mock.patch.object(self.app, '_bot_available_actions', side_effect=delayed), \
             mock.patch.object(self.app.native_worker_manager.game_worker, 'apply') as apply:
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': True})
            await asyncio.wait_for(started.wait(), 2)
            await self.app._handle_message(client, {'t': 'setHosting', 'enabled': False})
            release.set()
            await asyncio.wait_for(room['botTask'], 2)
            apply.assert_not_called()
