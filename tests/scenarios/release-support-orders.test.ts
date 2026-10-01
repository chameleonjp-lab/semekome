import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattle, stepBattle, type BattleIntent, type BattleState } from '../../src/simulation/physical-battle.ts';
import { validateSupportTypes } from '../../src/content/support-types.ts';

function intent(state: BattleState, allyCommand: BattleIntent['allyCommand']): BattleIntent {
  return { matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation, allyCommand };
}

test('all three support types, same-type pairs and unknown types are validated', () => {
  for (const type of ['carrier', 'interceptor', 'mechanic']) assert.deepEqual(validateSupportTypes([type, type]), [type, type]);
  assert.throws(() => validateSupportTypes(['carrier', 'secret']), /two/);
  const state = createBattle({ matchId: 'support-types', seed: 20260913, supportTypes: ['mechanic', 'interceptor'] });
  assert.deepEqual(state.supportTypes, { P2: 'mechanic', P3: 'interceptor' });
  assert.equal(Object.values(state.actors).filter(actor => actor.team === 'enemy').length, 30);
});

test('defense moves to a different authored room through ordinary floor paths; cancellation restores supply', () => {
  let state = createBattle({ matchId: 'support-defense-route', seed: 20260913 });
  const initial = { ...state.fixedActors.P2.position };
  state = stepBattle(state, intent(state, { allyId: 'P2', kind: 'defense', targetRoomId: 'repair', allyGeneration: 0 }));
  assert.equal(state.allyOrders.P2?.targetRoomId, 'repair');
  assert.ok(Math.hypot(state.fixedActors.P2.position.x - initial.x, state.fixedActors.P2.position.y - initial.y) < 150);
  for (let tick = 0; tick < 1500 && state.actors.P2.currentRoomId !== 'repair'; tick++) state = stepBattle(state);
  assert.equal(state.actors.P2.currentRoomId, 'repair');
  assert.equal(state.actors.P2.location.castleTeam, 'player');
  state = stepBattle(state, intent(state, { allyId: 'P2', kind: 'supply' }));
  assert.equal(state.allyOrders.P2, null);
});

test('invalid room or stale ally generation cannot replace an existing order', () => {
  let state = createBattle({ matchId: 'support-invalid-orders', seed: 4 });
  state = stepBattle(state, intent(state, { allyId: 'P2', kind: 'hold' }));
  state = stepBattle(state, intent(state, { allyId: 'P2', kind: 'invasion', targetRoomId: 'warp-core' }));
  assert.equal(state.allyOrders.P2?.kind, 'hold');
  state = stepBattle(state, intent(state, { allyId: 'P2', kind: 'artillery', allyGeneration: 99 }));
  assert.equal(state.allyOrders.P2?.kind, 'hold');
  assert.ok(state.lastStep.rejected.some(item => item.reason === 'stale_generation'));
  state.actors.P1.alive = false; state.actors.P1.health = 0;
  state = stepBattle(state);
  assert.equal(state.allyOrders.P2, null);
});

test('mechanic transports an actual supply case to repair and consumes it once', () => {
  let state = createBattle({ matchId: 'support-mechanic-repair', seed: 20260913, supportTypes: ['mechanic', 'carrier'] });
  state.castles.player.exterior.P7.health = 30; // Damaged-part boundary fixture; cases still come from normal supply.
  let repairCaseId: string | undefined;
  let completed = false;
  for (let tick = 0; tick < 3000 && !completed; tick++) {
    state = stepBattle(state);
    for (const event of state.lastStep.events) {
      if (event.type === 'repair_started' && event.actorId === 'P2') repairCaseId = event.objectId;
      if (event.type === 'repair_completed' && event.actorId === 'P2') completed = true;
    }
  }
  assert.ok(repairCaseId, 'P2 reserves an actual carried case in the repair room');
  assert.equal(completed, true);
  assert.ok(state.repairs.budgetUsed.player > 0);
  assert.ok(!state.actors.P2.cargoIds.includes(repairCaseId!));
  assert.ok(!Object.values(state.artillery.flights).some(flight => flight.objectId === repairCaseId));
});

test('repair preset E28 transports real supply and never gets two movement steps in one tick', () => {
  let state = createBattle({ matchId: 'enemy-repair-preset', seed: 20260913, preset: 'repair' });
  state.castles.enemy.exterior.P7.health = 30;
  let repairCaseId: string | undefined, completed = false;
  for (let tick = 0; tick < 3500 && !completed; tick++) {
    const before = { ...state.fixedActors.E28.position };
    state = stepBattle(state);
    const after = state.fixedActors.E28.position;
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) <= 51, 'patrol and repair cannot both move E28 in one tick');
    for (const event of state.lastStep.events) {
      if (event.type === 'repair_started' && event.actorId === 'E28') repairCaseId = event.objectId;
      if (event.type === 'repair_completed' && event.actorId === 'E28') completed = true;
    }
  }
  assert.ok(repairCaseId); assert.equal(completed, true);
  assert.ok(state.repairs.budgetUsed.enemy > 0);
  assert.ok(!state.actors.E28.cargoIds.includes(repairCaseId!));
  assert.ok(!Object.values(state.artillery.flights).some(flight => flight.objectId === repairCaseId));
});
