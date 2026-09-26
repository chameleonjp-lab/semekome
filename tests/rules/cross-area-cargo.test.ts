import assert from 'node:assert/strict';
import test from 'node:test';
import { assertObjectLocationsUnique } from '../../src/domain/objects.ts';
import type { ActorId, TeamId } from '../../src/domain/types.ts';
import { createBattle, getInteraction, stepBattle, type BattleHandle, type BattleState } from '../../src/simulation/physical-battle.ts';

// Trusted placement isolates cargo transitions; it does not certify traversal.
function place(state: BattleState, actorId: ActorId, area: TeamId | 'plaza', x: number, y: number, roomId = 'central_corridor'): void {
  const actor = state.actors[actorId];
  actor.location = area === 'plaza' ? { area, pathRooms: [], pathGates: [] }
    : { area: 'castle', castleTeam: area, roomId, pathRooms: [roomId], pathGates: [] };
  actor.currentRoomId = area === 'plaza' ? 'plaza' : roomId;
  actor.position = { x: Math.floor(x / 1000), y: Math.floor(y / 1000) };
  state.fixedActors[actorId] = { position: { x, y }, remainder: { x: 0, y: 0 } };
}

function handle(state: BattleState, kind: BattleHandle, actorId: ActorId = 'P1', slot = 0): BattleState {
  const interaction = getInteraction(state, actorId, slot);
  assert.ok(interaction.handles.includes(kind), `${kind} must be offered at the actual location`);
  const next = stepBattle(state, { matchId: state.matchId, actorId, generation: state.actors[actorId].generation,
    handle: kind, slot, contextToken: interaction.contextToken });
  assert.deepEqual(next.lastStep.rejected, []);
  assertObjectLocationsUnique(next);
  return next;
}

function fixture(sourceTeam: TeamId = 'player'): { state: BattleState; id: string } {
  let state = createBattle({ matchId: 'cargo-floor-audit', seed: 13 });
  for (const actor of Object.values(state.actors)) if (actor.id !== 'P1') {
    actor.alive = false; actor.health = 0; actor.respawnAtTick = 100_000;
  }
  for (const port of Object.values(state.logistics.ports)) port.nextSpawnTick = port.team === sourceTeam ? 0 : 100_000;
  state = stepBattle(state);
  const cargo = Object.values(state.battleCases).find(c => c.sourceTeam === sourceTeam && c.location === 'floor')!;
  assert.ok(cargo?.position);
  place(state, 'P1', sourceTeam, cargo.position.x, cargo.position.y, cargo.roomId);
  return { state: handle(state, 'pickup'), id: cargo.id };
}

test('invaded castle drop, repick and opponent theft preserve one case and its supply origin', () => {
  let { state, id } = fixture();
  const group = state.battleCases[id].originGroupId;
  place(state, 'P1', 'enemy', 31_500, 35_500);
  state = handle(state, 'drop');
  assert.deepEqual(state.battleCases[id].floorLocation, { area: 'castle', castleTeam: 'enemy' });
  assert.deepEqual(state.objects[id].location, { kind: 'floor', team: 'enemy', roomId: 'central_corridor', position: { x: 31, y: 35 } });
  assert.equal(state.battleCases[id].currentTeam, 'player', 'dropping changes location, not ownership');
  assert.equal(getInteraction(state).pickupCaseId, id);
  state = handle(state, 'pickup');
  const port = state.logistics.ports['enemy:supply_1'];
  place(state, 'P1', 'enemy', port.position.x + 1000, port.position.y, port.roomId);
  state = handle(state, 'drop');
  place(state, 'P1', 'enemy', 35_500, 35_500);
  const enemy = state.actors.E09;
  enemy.alive = true; enemy.health = 4; enemy.respawnAtTick = null;
  place(state, 'E09', 'enemy', port.position.x + 1000, port.position.y, port.roomId);
  state = stepBattle(state);
  assert.equal(state.battleCases[id].currentTeam, 'enemy');
  assert.equal(state.battleCases[id].sourceTeam, 'player');
  assert.equal(state.battleCases[id].originGroupId, group);
  assert.equal(state.logistics.groups[group].team, 'player');
  assert.equal(state.logistics.groups[group].retired, false);
  assert.deepEqual(state.actors.E09.cargoIds, [id]);
  assertObjectLocationsUnique(state);
});

test('stolen supply fires from the receiving castle without granting enemy equipment access', () => {
  let { state, id } = fixture('enemy');
  const source = state.battleCases[id].sourcePortId;
  const group = state.battleCases[id].originGroupId;
  const enemyTurret = state.artillery.turrets['enemy:T1'];
  place(state, 'P1', 'enemy', enemyTurret.operatorPosition.x, enemyTurret.operatorPosition.y, enemyTurret.roomId);
  assert.equal(getInteraction(state).handles.includes('deliver'), false);
  const rejected = stepBattle(state, { matchId: state.matchId, actorId: 'P1', generation: 0, handle: 'deliver', contextToken: getInteraction(state).contextToken });
  assert.ok(rejected.lastStep.rejected.length > 0);
  assert.equal(rejected.battleCases[id].location, 'carried');
  state = rejected;
  const ownTurret = state.artillery.turrets['player:T1'];
  place(state, 'P1', 'player', ownTurret.operatorPosition.x, ownTurret.operatorPosition.y, ownTurret.roomId);
  state = handle(state, 'deliver');
  const flight = Object.values(state.artillery.flights).find(f => f.objectId === id);
  assert.ok(flight);
  assert.equal(flight.team, 'player');
  assert.equal(flight.targetTeam, 'enemy');
  assert.equal(state.battleCases[id].sourceTeam, 'enemy');
  assert.equal(state.battleCases[id].sourcePortId, source);
  assert.equal(state.battleCases[id].originGroupId, group);
  assert.equal(state.logistics.groups[group].team, 'enemy');
});

test('stealing a physical handoff case releases exactly its original turret floor slot', () => {
  let { state, id } = fixture();
  const turret = state.artillery.turrets['enemy:T1'];
  const point = turret.stagingPositions[0];
  // Trusted fixture: a delivered case waiting on the enemy handoff floor.
  state.actors.P1.cargoIds = [];
  state.cargoSlots.P1 = [null, null];
  Object.assign(state.battleCases[id], { location: 'handoff', currentTeam: 'enemy', floorLocation: { area: 'castle', castleTeam: 'enemy' },
    ownerActorId: undefined, ownerGeneration: undefined, position: { ...point }, currentPosition: { ...point },
    turretId: turret.id, stagingSlot: 0, roomId: turret.roomId });
  turret.handoffIds = [id]; turret.stagingSlots = [id, null];
  state.objects[id].location = { kind: 'floor', team: 'enemy', roomId: turret.roomId, position: { x: Math.floor(point.x / 1000), y: Math.floor(point.y / 1000) } };
  place(state, 'P1', 'enemy', point.x, point.y, turret.roomId);
  state = handle(state, 'pickup');
  assert.deepEqual(state.artillery.turrets['enemy:T1'].handoffIds, []);
  assert.deepEqual(state.artillery.turrets['enemy:T1'].stagingSlots, [null, null]);
  assert.deepEqual(state.actors.P1.cargoIds, [id]);
  assert.equal(state.battleCases[id].sourceTeam, 'player');
  assert.equal(state.battleCases[id].currentTeam, 'player');
  assert.equal(state.battleCases[id].floorLocation, undefined);
  assert.equal(state.battleCases[id].turretId, undefined);
  assert.equal(getInteraction(state).handles.includes('deliver'), false);
});

test('plaza floor cases remain visible physical objects and cannot be picked through another area', () => {
  let { state, id } = fixture();
  place(state, 'P1', 'plaza', 31_500, 35_500);
  state = handle(state, 'drop');
  assert.deepEqual(state.battleCases[id].floorLocation, { area: 'plaza' });
  assert.deepEqual(state.objects[id].location, { kind: 'floor', area: 'plaza', team: 'player', roomId: 'plaza', position: { x: 31, y: 35 } });
  place(state, 'P1', 'enemy', 31_500, 35_500);
  assert.equal(getInteraction(state).handles.includes('pickup'), false);
  place(state, 'P1', 'plaza', 31_500, 35_500);
  state = handle(state, 'pickup');
  assert.equal(state.battleCases[id].floorLocation, undefined);
  state.actors.P1.health = 0;
  state = stepBattle(state);
  assert.equal(state.actors.P1.alive, false);
  assert.deepEqual(state.actors.P1.cargoIds, []);
  assert.deepEqual(state.battleCases[id].floorLocation, { area: 'plaza' });
  assert.equal(state.objects[id].location.kind === 'floor' && state.objects[id].location.area, 'plaza');
  assertObjectLocationsUnique(state);
});

test('contact and lethal drops in castles and plaza use the hit position before knockback', () => {
  for (const area of ['enemy', 'plaza'] as const) {
    for (const health of [4, 1]) {
      let { state, id } = fixture();
      const y = area === 'plaza' ? 35_500 : 57_500;
      place(state, 'P1', area, 50_000, y, 'command');
      state.actors.P1.health = health;
      const attacker = state.actors.E29;
      attacker.alive = true; attacker.health = 4; attacker.respawnAtTick = null;
      place(state, 'E29', area, 49_500, y, 'command');
      state.enemyDecisions.E29 = { generation: attacker.generation, nextDecisionTick: 100_000, intent: { kind: 'defend', targetId: 'P1' } };
      state = stepBattle(state);
      assert.ok(state.lastStep.events.some(e => e.type === 'actor_damaged' && e.actorId === 'P1'));
      const hit = state.lastStep.events.find(e => e.type === 'actor_damaged' && e.actorId === 'P1');
      assert.ok(hit && hit.type === 'actor_damaged');
      assert.deepEqual(hit.physicalLocation, area === 'plaza'
        ? { area, positionSubunits: { x: 50_000, y } }
        : { area: 'castle', castleTeam: 'enemy', positionSubunits: { x: 50_000, y } });
      assert.deepEqual(state.battleCases[id].floorLocation, area === 'plaza' ? { area } : { area: 'castle', castleTeam: 'enemy' });
      assert.deepEqual(state.battleCases[id].position, { x: 50_000, y });
      assert.deepEqual(state.objects[id].location, area === 'plaza'
        ? { kind: 'floor', area, team: 'player', roomId: 'plaza', position: { x: 50, y: 35 } }
        : { kind: 'floor', team: 'enemy', roomId: 'command', position: { x: 50, y: 57 } });
      const moved = state.lastStep.events.find(e => e.type === 'object_moved' && e.objectId === id);
      assert.ok(moved && moved.type === 'object_moved');
      assert.deepEqual(moved.location, state.objects[id].location);
      assert.equal(state.battleCases[id].sourceTeam, 'player');
      assert.deepEqual(state.cargoSlots.P1, [null, null]);
      assert.equal(state.actors.P1.alive, health > 1);
      assertObjectLocationsUnique(state);
    }
  }
});
