import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_IDS, PART_IDS, type WorldEvent } from '../../src/domain/types.ts';
import { createBattle, stepBattle, type BattleState } from '../../src/simulation/physical-battle.ts';
import { actorRespawnAnchor, actorVisibleToPlayer, floorCaseAnchor, getCoreAccessProjection, projectStepRenderEffects, snapshotFlights, type FlightRenderSnapshot } from '../../src/presentation/battle-projection.ts';

function withEvents(events: WorldEvent[]): BattleState {
  const state = createBattle({ matchId: 'projection-audit', seed: 13 });
  state.tick = 11;
  state.lastStep = { advanced: true, processedTick: 10, acceptedInputKinds: [], rejected: [], events };
  return state;
}

test('hit effects freeze the actual contact area and subunit point before knockback', () => {
  const state = withEvents([{ type: 'actor_damaged', actorId: 'P1', amount: 1,
    physicalLocation: { area: 'castle', castleTeam: 'enemy', positionSubunits: { x: 50_125, y: 57_500 } } }]);
  state.fixedActors.P1.position = { x: 50_725, y: 57_500 };
  const before = JSON.stringify(state);
  const effects = projectStepRenderEffects(state, new Map());
  assert.equal(JSON.stringify(state), before, 'projection must not change the simulation');
  state.fixedActors.P1.position.x += 5000;
  state.actors.P1.location = { area: 'plaza', pathRooms: [], pathGates: [] };
  assert.deepEqual(effects[0].anchor, { area: 'castle', team: 'enemy', point: { x: 50.125, y: 57.5 } });
});

test('separate armor hits keep their targets and a destroyed plate creates one damage flash', () => {
  const state = withEvents([
    { type: 'part_damaged', team: 'enemy', partId: 'P1', amount: 14 },
    { type: 'part_damaged', team: 'enemy', partId: 'P7', amount: 8 },
    { type: 'part_destroyed', team: 'enemy', partId: 'P7', gateId: 'G1' },
  ]);
  const effects = projectStepRenderEffects(state, new Map());
  const hits = effects.filter(e => e.kind === 'part_damaged' || e.kind === 'part_destroyed');
  assert.deepEqual(hits.map(e => e.partId), ['P1', 'P7']);
  assert.notDeepEqual(hits[0].anchor, hits[1].anchor);
  assert.notDeepEqual(hits[0].plazaAnchor, hits[1].plazaAnchor);
  assert.equal(effects.find(e => e.kind === 'gate_opened')?.gateId, 'G1', 'open the next prefix gate, not a gate inferred from P7');
  assert.equal(effects.some(e => e.kind === 'core_unlocked'), false);
});

test('core is attackable only with all seven gates and no existing core hit', () => {
  const state = createBattle({ matchId: 'core-audit', seed: 13 });
  for (const id of GATE_IDS.slice(0, 6)) state.castles.enemy.gates[id].open = true;
  assert.deepEqual(getCoreAccessProjection(state, 'enemy'), { openGateCount: 6, protected: true, attackable: false, hit: false });
  state.castles.enemy.gates.G7.open = true;
  assert.equal(getCoreAccessProjection(state, 'enemy').attackable, true);
  state.castles.enemy.core.hit = true;
  assert.equal(getCoreAccessProjection(state, 'enemy').attackable, false);
});

test('respawn preview uses the actual home pad even after death in the opposing castle', () => {
  let state = createBattle({ matchId: 'respawn-audit', seed: 13 });
  const actor = state.actors.E29;
  actor.alive = false; actor.health = 0; actor.respawnAtTick = 0;
  actor.location = { area: 'castle', castleTeam: 'player', roomId: 'central_corridor', pathRooms: [], pathGates: [] };
  state.fixedActors.E29.position = { x: 94_500, y: 35_500 };
  const anchor = actorRespawnAnchor(state, 'E29');
  state = stepBattle(state);
  assert.equal(state.actors.E29.alive, true);
  assert.equal(anchor?.team, 'enemy');
  assert.deepEqual(anchor?.point, { x: state.fixedActors.E29.position.x / 1000, y: state.fixedActors.E29.position.y / 1000 });
});

test('interception is independent of projectile event ordering at an asymmetric contact', () => {
  const previous = new Map<string, FlightRenderSnapshot>([
    ['p', { id: 'p', objectId: 'pc', team: 'player', route: 'direct', progress: .29, distanceUnits: 120, speedUnitsPerSecond: 144 }],
    ['e', { id: 'e', objectId: 'ec', team: 'enemy', route: 'direct', progress: .69, distanceUnits: 120, speedUnitsPerSecond: 144 }],
  ]);
  const first = { type: 'projectile_intercepted', firstProjectileId: 'p', secondProjectileId: 'e' } as WorldEvent;
  const reversed = { type: 'projectile_intercepted', firstProjectileId: 'e', secondProjectileId: 'p' } as WorldEvent;
  const forward = projectStepRenderEffects(withEvents([first]), previous)[0];
  const backward = projectStepRenderEffects(withEvents([reversed]), previous)[0];
  assert.equal(forward.route, 'direct');
  assert.ok(Math.abs(forward.progress! - .3) < 1e-12);
  assert.equal(backward.progress, forward.progress);
});

test('pruned defensive ammo and all-destroyed armor do not become damage or core flashes', () => {
  const initial = createBattle({ matchId: 'prune-audit', seed: 13 });
  initial.battleCases.panel = { id: 'panel', type: 'screen_panel' } as BattleState['battleCases'][string];
  initial.artillery.flights.flight = { id: 'flight', objectId: 'panel', team: 'player', route: 'direct', progress: .99, distanceUnits: 120, speedUnitsPerSecond: 9 } as BattleState['artillery']['flights'][string];
  const previous = snapshotFlights(initial);
  const impact = { type: 'projectile_impacted', objectId: 'panel', projectileId: 'flight', targetTeam: 'enemy', targetPart: 'P4' } as WorldEvent;
  const state = withEvents([impact]);
  const defensive = projectStepRenderEffects(state, previous);
  assert.equal(defensive[0].caseType, 'screen_panel');
  assert.equal(defensive.some(e => e.kind === 'part_damaged' || e.kind === 'core_unlocked'), false);
  for (const id of PART_IDS) state.castles.enemy.exterior[id].destroyed = true;
  state.lastStep.events = [{ ...impact, targetPart: undefined } as WorldEvent];
  assert.equal(projectStepRenderEffects(state, previous)[0].kind, 'projectile_no_target');
});

test('floor projection uses the physical area and converts subunits exactly once', () => {
  const state = createBattle({ matchId: 'floor-projection', seed: 13 });
  state.battleCases.case = { id: 'case', location: 'floor', currentTeam: 'player', sourceTeam: 'player', floorLocation: { area: 'castle', castleTeam: 'enemy' }, currentPosition: { x: 31_500, y: 35_750 } } as BattleState['battleCases'][string];
  state.objects.case = { id: 'case', sourceTeam: 'player', weight: 1, location: { kind: 'floor', team: 'enemy', roomId: 'central_corridor', position: { x: 31, y: 35 } } };
  assert.deepEqual(floorCaseAnchor(state, 'case'), { area: 'castle', team: 'enemy', point: { x: 31.5, y: 35.75 } });
  state.battleCases.case.floorLocation = { area: 'plaza' };
  state.objects.case.location = { kind: 'floor', area: 'plaza', team: 'player', roomId: 'plaza', position: { x: 31, y: 35 } };
  assert.deepEqual(floorCaseAnchor(state, 'case'), { area: 'plaza', point: { x: 31.5, y: 35.75 } });
});

test('unseen-room enemies stay off the live view while local threats, allies and plaza spectators remain visible', () => {
  const state = createBattle({ matchId: 'visibility-audit', seed: 13 });
  const player = state.actors.P1, enemy = state.actors.E29;
  player.location = { area: 'castle', castleTeam: 'enemy', roomId: 'command', pathRooms: ['command'], pathGates: [] };
  player.currentRoomId = 'command'; state.fixedActors.P1.position = { x: 49_500, y: 57_500 };
  enemy.location = { ...player.location }; enemy.currentRoomId = 'command'; state.fixedActors.E29.position = { x: 50_000, y: 57_500 };
  assert.equal(actorVisibleToPlayer(state, 'E29'), true);
  assert.equal(actorVisibleToPlayer(state, 'E01'), false, 'another room must not reveal its occupant');
  assert.equal(actorVisibleToPlayer(state, 'P2'), true, 'friendly location reporting remains available');
  enemy.location.castleTeam = 'player';
  assert.equal(actorVisibleToPlayer(state, 'E29'), false, 'matching room names in different castles are distinct');
  player.alive = false; enemy.location = { area: 'plaza', pathRooms: [], pathGates: [] };
  assert.equal(actorVisibleToPlayer(state, 'E29'), true, 'spectators see the ongoing open plaza');
  assert.equal(actorVisibleToPlayer(state, 'E01'), false);
});

test('a closed gate blocks presentation sight even if a stale room label matches', () => {
  const state = createBattle({ matchId: 'gate-visibility-audit', seed: 13 });
  for (const id of ['P1', 'E29']) {
    state.actors[id].location = { area: 'castle', castleTeam: 'player', roomId: 'corridor_0', pathRooms: ['corridor_0'], pathGates: [] };
    state.actors[id].currentRoomId = 'corridor_0';
  }
  state.fixedActors.P1.position = { x: 47_500, y: 33_500 };
  state.fixedActors.E29.position = { x: 44_500, y: 33_500 };
  assert.equal(actorVisibleToPlayer(state, 'E29'), false);
  state.castles.player.gates.G1.open = true;
  assert.equal(actorVisibleToPlayer(state, 'E29'), true);
});
