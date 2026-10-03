import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattle, stepBattle, type BattleState } from '../../src/simulation/physical-battle.ts';
import { assertObjectLocationsUnique } from '../../src/domain/objects.ts';

function suppliedFixture(count = 6) {
  let state = createBattle({ matchId: 'automatic-cargo-economy', seed: 195 });
  for (const actor of Object.values(state.actors)) actor.protectedUntilTick = 100_000;
  for (const port of Object.values(state.logistics.ports)) port.nextSpawnTick = 100_000;
  for (let index = 0; index < count; index++) {
    state.logistics.ports['enemy:supply_1'].nextSpawnTick = state.tick;
    state = stepBattle(state);
  }
  for (const port of Object.values(state.logistics.ports)) port.nextSpawnTick = 100_000;
  const ids = Object.keys(state.battleCases).sort();
  assert.equal(ids.length, count, 'all ammunition comes from actual supply generation');
  return { state, ids };
}
function carryAtTurret(state: BattleState, actorId: string, ids: string[]) {
  const turret = state.artillery.turrets['enemy:T1'];
  const actor = state.actors[actorId];
  actor.protectedUntilTick = null;
  actor.location = { area: 'castle', castleTeam: 'enemy', roomId: turret.roomId, pathRooms: [turret.roomId], pathGates: [] };
  actor.currentRoomId = turret.roomId;
  actor.position = { x: Math.floor(turret.operatorPosition.x / 1000), y: Math.floor(turret.operatorPosition.y / 1000) };
  state.fixedActors[actorId] = { position: { ...turret.operatorPosition } };
  actor.cargoIds = [...ids];
  state.cargoSlots[actorId] = [...ids, ...Array(5 - ids.length).fill(null)];
  ids.forEach((id, slot) => {
    const item = state.battleCases[id];
    item.location = 'carried'; item.floorLocation = undefined; item.position = undefined;
    item.ownerActorId = actorId; item.ownerGeneration = actor.generation; item.currentTeam = 'enemy';
    item.currentPosition = { ...turret.operatorPosition };
    state.objects[id].location = { kind: 'carried', actorId, slot };
  });
  state.enemyDecisions[actorId] = { generation: actor.generation, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'cargo economy fixture' } };
}
function handoff(state: BattleState, id: string) {
  const turret = state.artillery.turrets['enemy:T1'];
  const item = state.battleCases[id];
  item.location = 'handoff'; item.turretId = turret.id; item.stagingSlot = 0;
  item.roomId = turret.roomId; item.position = { ...turret.stagingPositions[0] }; item.currentPosition = { ...item.position };
  turret.handoffIds = [id]; turret.stagingSlots = [id, null];
}
test('full five-case assigned shooter frees a slot and eventually fires all carried and staged ammunition', { timeout: 60_000 }, () => {
  let { state, ids } = suppliedFixture();
  carryAtTurret(state, 'E01', ids.slice(0, 5));
  handoff(state, ids[5]);
  const launched = new Set<string>();
  for (let tick = 0; tick < 1_600; tick++) {
    state = stepBattle(state);
    for (const event of state.lastStep.events) if (event.type === 'projectile_launched') {
      assert.equal(event.sourceActorId, 'E01');
      assert.equal(launched.has(event.objectId), false, 'one supplied object is launched once');
      launched.add(event.objectId);
    }
    assertObjectLocationsUnique(state);
  }
  assert.deepEqual([...launched].sort(), ids);
  assert.equal(state.actors.E01.cargoIds.length, 0);
  assert.equal(state.artillery.turrets['enemy:T1'].handoffIds.length, 0);
  assert.equal(Object.values(state.logistics.groups).filter(group => !group.retired).length, 0, 'all six source groups retire after real impacts');
});
test('full shooter cannot bypass disabled equipment, its assigned turret or spawn protection', () => {
  for (const blocker of ['disabled', 'wrong-assignment', 'protected'] as const) {
    let { state, ids } = suppliedFixture();
    carryAtTurret(state, 'E01', ids.slice(0, 5));
    handoff(state, ids[5]);
    if (blocker === 'disabled') state.artillery.turrets['enemy:T1'].disabledUntilTick = 1000;
    if (blocker === 'wrong-assignment') state.actors.E01.turretId = 'T2';
    if (blocker === 'protected') state.actors.E01.protectedUntilTick = 1000;
    state = stepBattle(state);
    assert.equal(state.actors.E01.cargoIds.length, 5, blocker);
    assert.equal(state.artillery.turrets['enemy:T1'].queueIds.length, 0, blocker);
    assert.equal(state.battleCases[ids[5]].location, 'handoff', blocker);
    assertObjectLocationsUnique(state);
  }
});
test('ordinary soldiers deliver collected ammunition as physical handoff without becoming cannon operators', { timeout: 60_000 }, () => {
  let { state, ids } = suppliedFixture(5);
  carryAtTurret(state, 'E17', ids);
  state = stepBattle(state);
  assert.ok(state.actors.E17.cargoIds.length < 5, 'collected cargo enters the real delivery path');
  assert.equal(state.artillery.turrets['enemy:T1'].queueIds.length, 0, 'protected dedicated shooter cannot load');
  assert.equal(Object.keys(state.artillery.flights).length, 0, 'the soldier cannot fire');
  for (const id of ['E01', 'E02', 'E03', 'E04']) state.actors[id].protectedUntilTick = null;
  const launched = new Set<string>();
  for (let tick = 0; tick < 1_800; tick++) {
    state = stepBattle(state);
    for (const event of state.lastStep.events) if (event.type === 'projectile_launched') {
      assert.notEqual(event.sourceActorId, 'E17');
      launched.add(event.objectId);
    }
  }
  assert.equal(state.actors.E17.cargoIds.length, 0);
  assert.deepEqual([...launched].sort(), ids);
  assertObjectLocationsUnique(state);
});
test('explicit collect replaces follow and makes mechanic/interceptor supports deliver actual ammunition', { timeout: 60_000 }, () => {
  for (const type of ['mechanic', 'interceptor'] as const) {
    let state = createBattle({ matchId: `collect-${type}`, seed: 712, supportTypes: [type, 'carrier'] });
    for (const actor of Object.values(state.actors)) actor.protectedUntilTick = 100_000;
    for (const port of Object.values(state.logistics.ports)) port.nextSpawnTick = 100_000;
    state.logistics.ports['player:supply_1'].nextSpawnTick = 0;
    state = stepBattle(state);
    const item = Object.values(state.battleCases)[0];
    assert.ok(item?.position);
    const id = item.id;
    for (const port of Object.values(state.logistics.ports)) port.nextSpawnTick = 100_000;
    const actor = state.actors.P2;
    actor.location = { area: 'castle', castleTeam: 'player', roomId: item.roomId, pathRooms: [item.roomId], pathGates: [] };
    actor.currentRoomId = item.roomId;
    actor.position = { x: Math.floor(item.position.x / 1000), y: Math.floor(item.position.y / 1000) };
    state.fixedActors.P2 = { position: { ...item.position } };
    actor.protectedUntilTick = null;
    state.actors.P1.protectedUntilTick = null;
    state.castles.player.exterior.P1.health = 10;
    state = stepBattle(state, { matchId: state.matchId, actorId: 'P1', generation: 0, allyCommand: { allyId: 'P2', kind: 'follow' } });
    state = stepBattle(state, { matchId: state.matchId, actorId: 'P1', generation: 0, allyCommand: { allyId: 'P2', kind: 'collect' } });
    assert.equal(state.allyOrders.P2?.kind, 'collect');
    let delivered = false;
    for (let tick = 0; tick < 2_000 && !delivered; tick++) {
      state = stepBattle(state);
      assert.equal(Boolean(state.repairs.tasks.P2 || state.repairs.equipmentTasks.P2), false, 'explicit collection overrides type-specific repair work');
      delivered = ['handoff', 'queue', 'flying', 'consumed'].includes(state.battleCases[id].location);
    }
    assert.equal(delivered, true, type);
    assert.equal(state.allyOrders.P2?.kind, 'collect');
    assertObjectLocationsUnique(state);
  }
});
