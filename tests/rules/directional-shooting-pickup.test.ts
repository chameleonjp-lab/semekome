import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattle, stepBattle, pauseBattle, getInteraction, PERSONAL_SHOT_COOLDOWN_TICKS, type BattleState, type BattleIntent, type BattleCaseState } from '../../src/simulation/physical-battle.ts';
import { ACTOR_SPEED_SUBUNITS_PER_TICK } from '../../src/actors/movement.ts';
import { canCarry, carryingSpeedMultiplier } from '../../src/logistics/logistics.ts';
import { assertObjectLocationsUnique } from '../../src/domain/objects.ts';

function fixture(): BattleState {
  const state = createBattle({ matchId: 'new-controls', seed: 128 });
  for (const actor of Object.values(state.actors)) actor.protectedUntilTick = 100_000;
  state.actors.P1.protectedUntilTick = null;
  place(state, 'P1', 60_500, 34_500);
  return state;
}
function place(state: BattleState, id: string, x: number, y: number) {
  const actor = state.actors[id];
  actor.location = { area: 'castle', castleTeam: 'player', roomId: 'central_corridor', pathRooms: ['central_corridor'], pathGates: [] };
  actor.currentRoomId = 'central_corridor';
  actor.position = { x: Math.floor(x / 1000), y: Math.floor(y / 1000) };
  state.fixedActors[id] = { position: { x, y }, remainder: { x: 0, y: 0 } };
}
function input(state: BattleState, fields: Partial<BattleIntent> = {}): BattleIntent {
  return { matchId: state.matchId, actorId: 'P1', generation: state.actors.P1.generation, ...fields };
}
function caseAt(state: BattleState, id: string, actorId = 'P1') {
  const position = { ...state.fixedActors[actorId].position };
  state.battleCases[id] = { id, type: 'dense_payload', weight: 2, sourceTeam: 'player', currentTeam: 'player', location: 'floor', floorLocation: { area: 'castle', castleTeam: 'player' }, roomId: 'central_corridor', createdTick: 0, position, currentPosition: position, originGroupId: id, sourcePortId: 'supply_1' } as BattleCaseState;
}
test('all actors move faster; carrying is five objects regardless of weight', () => {
  assert.equal(ACTOR_SPEED_SUBUNITS_PER_TICK, 100);
  assert.equal(canCarry(8, 2, 4), true);
  assert.equal(canCarry(0, 1, 5), false);
  assert.equal(carryingSpeedMultiplier(10), 1);
  let state = fixture();
  const before = state.fixedActors.P1.position.x;
  state = stepBattle(state, input(state, { direction: { x: 1, y: 0 } }));
  assert.equal(state.fixedActors.P1.position.x - before, 100);
});
test('shot follows movement, remains facing while stationary, hits first enemy only', () => {
  let state = fixture();
  place(state, 'E29', 63_500, 34_500);
  place(state, 'E30', 65_500, 34_500);
  for (const id of ['E29', 'E30']) {
    state.actors[id].protectedUntilTick = null;
    state.enemyDecisions[id] = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'shot fixture' } };
  }
  state = stepBattle(state, input(state, { direction: { x: 1, y: 0 } }));
  state = stepBattle(state, input(state, { direction: { x: 0, y: 0 }, shoot: true }));
  assert.deepEqual(state.actorFacing.P1, { x: 1, y: 0 });
  assert.equal(state.actors.E29.health, 2);
  assert.equal(state.actors.E30.health, 4);
  assert.equal(state.shots.filter(shot => shot.actorId === 'P1').length, 1);
  const after = state.actors.E29.health;
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.actors.E29.health, after, 'cooldown prevents per-tick spam');
  assert.equal(state.shootCooldownUntilTick.P1, 1 + PERSONAL_SHOT_COOLDOWN_TICKS);
});
test('firing empty air is accepted and shots cannot damage core or exterior', () => {
  let state = fixture();
  state = stepBattle(state, input(state, { direction: { x: -1, y: 0 }, shoot: true }));
  assert.ok(state.lastStep.acceptedInputKinds.includes('shoot'));
  assert.equal(state.lastStep.rejected.length, 0);
  assert.equal(state.outcome, 'ongoing');
  assert.equal(state.castles.enemy.destroyedPartIds.length, 0);
  assert.ok(state.shots[0].to.x < state.shots[0].from.x);
  const paused = pauseBattle(state);
  assert.equal(stepBattle(paused, input(paused, { shoot: true })).shots.length, paused.shots.length);
});
test('automatic pickup fills five stable slots and leaves the sixth object on floor', () => {
  let state = fixture();
  for (let index = 0; index < 6; index++) caseAt(state, `case-${index}`);
  state = stepBattle(state);
  assert.equal(state.actors.P1.cargoIds.length, 5);
  assert.equal(state.cargoSlots.P1.filter(Boolean).length, 5);
  assert.equal(state.battleCases['case-5'].location, 'floor');
  assert.equal(new Set(state.actors.P1.cargoIds).size, 5);
});
test('NPC automatic pickup uses the same five-count limit', () => {
  let state = fixture();
  place(state, 'E29', 70_500, 34_500);
  state.actors.E29.protectedUntilTick = null;
  state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'pickup fixture' } };
  for (let index = 0; index < 6; index++) caseAt(state, `npc-case-${index}`, 'E29');
  state = stepBattle(state);
  assert.equal(state.actors.E29.cargoIds.length, 5);
});
test('explicit follow moves both allies toward P1 inside the home castle', () => {
  let state = fixture();
  for (const [id, x] of [['P2', 55_500], ['P3', 53_500]] as const) {
    place(state, id, x, 34_500);
    state.actors[id].protectedUntilTick = null;
    state = stepBattle(state, input(state, { allyCommand: { allyId: id, kind: 'follow' } }));
  }
  const before = ['P2', 'P3'].map(id => Math.abs(state.fixedActors.P1.position.x - state.fixedActors[id].position.x));
  for (let index = 0; index < 12; index++) state = stepBattle(state);
  for (const [index, id] of ['P2', 'P3'].entries()) {
    assert.equal(state.allyOrders[id as 'P2' | 'P3']?.kind, 'follow');
    assert.ok(Math.abs(state.fixedActors.P1.position.x - state.fixedActors[id].position.x) < before[index]);
  }
});

test('freshly dropped cargo remains on the floor for half a second', () => {
  let state = fixture();
  caseAt(state, 'drop-grace');
  state = stepBattle(state);
  state = stepBattle(state, input(state, { handle: 'drop', slot: 0, contextToken: getInteraction(state).contextToken }));
  const droppedAt = state.tick - 1;
  for (let index = 0; index < 29; index++) state = stepBattle(state);
  assert.equal(state.battleCases['drop-grace'].location, 'floor');
  assert.equal(state.tick, droppedAt + 30);
  state = stepBattle(state);
  assert.equal(state.battleCases['drop-grace'].location, 'carried');
});
test('closed gates block directional shots without opening gates or hitting the core', () => {
  let state = fixture();
  place(state, 'P1', 48_500, 34_500);
  place(state, 'E29', 44_500, 34_500);
  state.actorFacing.P1 = { x: -1, y: 0 };
  state.actors.E29.protectedUntilTick = null;
  state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'gate fixture' } };
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.actors.E29.health, 4);
  assert.ok(state.shots.find(shot => shot.actorId === 'P1')!.to.x >= 47_000);
  assert.equal(state.castles.player.openGateIds.length, 0);
  assert.equal(state.castles.player.core.hit, false);
});
test('shot deaths preserve enemy20sec and player5sec respawn schedules and fixed30 roster', () => {
  let state = fixture();
  place(state, 'E29', 63_500, 34_500);
  state.actors.E29.health = 2;
  state.actors.E29.protectedUntilTick = null;
  state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'death fixture' } };
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.actors.E29.alive, false);
  assert.equal(state.actors.E29.respawnAtTick, 1200);
  state.actors.P1.health = 0;
  state = stepBattle(state);
  assert.equal(state.actors.P1.respawnAtTick, 301);
  assert.equal(Object.values(state.actors).filter(actor => actor.team === 'enemy').length, 30);
});

function placeForCoreShot(state: BattleState, actorId: string, team: 'player' | 'enemy') {
  const layout = team === 'player' ? state.layout.home : state.layout.enemy;
  const core = layout.rooms.find(room => room.id === 'core')!;
  const center = { x: (core.rect.x0 + core.rect.x1) * 500, y: (core.rect.y0 + core.rect.y1) * 500 };
  const direction = team === 'player' ? -1 : 1;
  const position = { x: center.x - direction * 2_000, y: center.y };
  for (const part of Object.values(state.castles[team].exterior)) { part.health = 0; part.destroyed = true; }
  state.castles[team].destroyedPartIds = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
  state.castles[team].openGateIds = [...layout.coreRouteGates];
  for (const gate of Object.values(state.castles[team].gates)) gate.open = true;
  const actor = state.actors[actorId];
  actor.location = { area: 'castle', castleTeam: team, roomId: 'core', pathRooms: [...layout.coreRouteRooms], pathGates: [...layout.coreRouteGates] };
  actor.currentRoomId = 'core';
  actor.position = { x: Math.floor(position.x / 1000), y: Math.floor(position.y / 1000) };
  actor.protectedUntilTick = null;
  state.fixedActors[actorId] = { position, remainder: { x: 0, y: 0 } };
  state.actorFacing[actorId] = { x: direction, y: 0 };
  return { center, position };
}
test('a facing shot wins only after all seven gates and recorded route into enemy core room', () => {
  let state = fixture();
  placeForCoreShot(state, 'P1', 'enemy');
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.outcome, 'player_win');
  assert.equal(state.castles.enemy.core.hit, true);
  assert.ok(state.lastStep.acceptedInputKinds.includes('bridge:core_contact'));
  const ended = stepBattle(state, input(state, { shoot: true }));
  assert.equal(ended.tick, state.tick);
  assert.deepEqual(ended.shots, state.shots);
  for (const violation of ['closed-gate', 'missing-route', 'wrong-facing'] as const) {
    let invalid = fixture();
    placeForCoreShot(invalid, 'P1', 'enemy');
    if (violation === 'closed-gate') invalid.castles.enemy.gates.G7.open = false;
    if (violation === 'missing-route') invalid.actors.P1.location.pathGates = [];
    if (violation === 'wrong-facing') invalid.actorFacing.P1 = { x: -1, y: 0 };
    invalid = stepBattle(invalid, input(invalid, { shoot: true }));
    assert.equal(invalid.outcome, 'ongoing', violation);
  }
});
test('the first defender blocks a core shot, including protected defenders', () => {
  for (const protectedTarget of [false, true]) {
    let state = fixture();
    const { position } = placeForCoreShot(state, 'P1', 'enemy');
    const guard = state.actors.E29;
    guard.location = { ...state.actors.P1.location, pathRooms: ['core'], pathGates: [] };
    guard.currentRoomId = 'core';
    guard.position = { x: Math.floor((position.x + 500) / 1000), y: Math.floor(position.y / 1000) };
    guard.protectedUntilTick = protectedTarget ? 100_000 : null;
    state.fixedActors.E29 = { position: { x: position.x + 500, y: position.y } };
    state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'first blocker' } };
    state = stepBattle(state, input(state, { shoot: true }));
    assert.equal(state.outcome, 'ongoing');
    assert.equal(state.castles.enemy.core.hit, false);
    assert.equal(state.actors.E29.health, protectedTarget ? 4 : 2);
  }
});
test('opposing valid core shots resolve together as a draw', () => {
  let state = fixture();
  placeForCoreShot(state, 'P1', 'enemy');
  placeForCoreShot(state, 'E29', 'player');
  state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'simultaneous core shot' } };
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.outcome, 'draw');
  assert.equal(state.castles.player.core.hit, true);
  assert.equal(state.castles.enemy.core.hit, true);
  assert.equal(state.lastStep.events.filter(event => event.type === 'core_hit_candidate').length, 2);
});
test('shots drop the selected cargo slot and preserve the other four objects', () => {
  let state = fixture();
  for (let index = 0; index < 5; index++) caseAt(state, `selected-${index}`);
  state = stepBattle(state);
  state = stepBattle(state, input(state, { slot: 4 }));
  place(state, 'E29', 63_500, 34_500);
  state.actors.E29.protectedUntilTick = null;
  state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'selected drop' } };
  state = stepBattle(state);
  assert.equal(state.actors.P1.health, 2);
  assert.equal(state.battleCases['selected-4'].location, 'floor');
  assert.equal(state.cargoSlots.P1[4], null);
  assert.deepEqual(state.actors.P1.cargoIds, ['selected-0', 'selected-1', 'selected-2', 'selected-3']);
  assert.equal(state.objects['selected-4'].location.kind, 'floor');
});
test('stale generations, protected actors and invalid shooting envelopes cannot fire', () => {
  const original = fixture();
  for (const fields of [{ generation: 99, shoot: true }, { shoot: true, attack: true }, { shoot: true, dash: { x: 1 as const, y: 0 as const } }]) {
    const state = stepBattle(original, input(original, fields));
    assert.equal(state.shots.filter(shot => shot.actorId === 'P1').length, 0);
    assert.ok(state.lastStep.rejected.length > 0);
  }
  original.actors.P1.protectedUntilTick = 60;
  assert.equal(stepBattle(original, input(original, { shoot: true })).shots.filter(shot => shot.actorId === 'P1').length, 0);
});

test('live mobility dash moves faster, faces travel and stops at an actor without damage', () => {
  let state = fixture();
  place(state, 'E29', 61_700, 34_500);
  const start = state.fixedActors.P1.position.x;
  state = stepBattle(state, input(state, { mobilityDash: { x: 1, y: 0 } }));
  assert.ok(state.lastStep.acceptedInputKinds.includes('mobilityDash'));
  assert.equal(state.fixedActors.P1.position.x - start, 200);
  while (state.dashes.P1) state = stepBattle(state);
  assert.deepEqual(state.actorFacing.P1, { x: 1, y: 0 });
  assert.equal(state.actors.E29.health, 4);
  assert.ok(state.fixedActors.P1.position.x <= 61_140);
  assert.equal(state.lastStep.events.some(event => event.type === 'actor_damaged'), false);
});
test('live mobility dash stops at the core without victory; a subsequent directional shot wins', () => {
  let state = fixture();
  placeForCoreShot(state, 'P1', 'enemy');
  state = stepBattle(state, input(state, { mobilityDash: { x: 1, y: 0 } }));
  while (state.dashes.P1) state = stepBattle(state);
  assert.equal(state.castles.enemy.core.hit, false);
  assert.equal(state.outcome, 'ongoing');
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.outcome, 'player_win');
});
test('directional shots damage first hostile equipment, while mobility contact and friendly shots do not', () => {
  for (const mode of ['shot', 'mobility', 'friendly'] as const) {
    let state = fixture();
    const team = mode === 'friendly' ? 'player' : 'enemy';
    const turret = state.artillery.turrets[`${team}:T1`];
    const actor = state.actors.P1;
    const position = { x: turret.position.x - 1_500, y: turret.position.y };
    actor.location = { area: 'castle', castleTeam: team, roomId: turret.roomId, pathRooms: [turret.roomId], pathGates: [] };
    actor.currentRoomId = turret.roomId;
    actor.position = { x: Math.floor(position.x / 1000), y: Math.floor(position.y / 1000) };
    state.fixedActors.P1 = { position };
    state.actorFacing.P1 = { x: 1, y: 0 };
    const initialHealth = turret.health;
    state = stepBattle(state, input(state, mode === 'mobility' ? { mobilityDash: { x: 1, y: 0 } } : { shoot: true }));
    while (state.dashes.P1) state = stepBattle(state);
    assert.equal(state.artillery.turrets[`${team}:T1`].health, initialHealth - (mode === 'shot' ? 10 : 0), mode);
    assert.equal(state.outcome, 'ongoing');
  }
});
test('mobility dash grants no immunity and does not silence automatic enemy shooting', () => {
  let state = fixture();
  place(state, 'P1', 90_500, 34_500);
  place(state, 'E29', 93_500, 34_500);
  state.actors.E29.protectedUntilTick = null;
  state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'no mobility immunity' } };
  state = stepBattle(state, input(state, { mobilityDash: { x: 0, y: 1 } }));
  assert.equal(state.actors.P1.health, 2);
  assert.ok(state.shots.some(shot => shot.actorId === 'E29'));
});
test('an intervening defender prevents a directional shot from damaging equipment behind it', () => {
  let state = fixture();
  const turret = state.artillery.turrets['enemy:T1'];
  const position = { x: turret.position.x - 1_500, y: turret.position.y };
  for (const [id, x] of [['P1', position.x], ['E29', position.x + 600]] as const) {
    const actor = state.actors[id];
    actor.location = { area: 'castle', castleTeam: 'enemy', roomId: turret.roomId, pathRooms: [turret.roomId], pathGates: [] };
    actor.currentRoomId = turret.roomId;
    actor.position = { x: Math.floor(x / 1000), y: Math.floor(position.y / 1000) };
    state.fixedActors[id] = { position: { x, y: position.y } };
  }
  state.actorFacing.P1 = { x: 1, y: 0 };
  const health = turret.health;
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.artillery.turrets['enemy:T1'].health, health);
  assert.ok(state.shots.find(shot => shot.actorId === 'P1')!.to.x < turret.position.x - 300);
});

function carriedFixture(state: BattleState, actorId: string): string[] {
  const actor = state.actors[actorId];
  const ids = Array.from({ length: 5 }, (_, slot) => `${actorId}-core-cargo-${slot}`);
  for (const [slot, id] of ids.entries()) {
    caseAt(state, id, actorId);
    Object.assign(state.battleCases[id], { location: 'carried', floorLocation: undefined, position: undefined,
      roomId: actor.currentRoomId, currentTeam: actor.team, ownerActorId: actorId, ownerGeneration: actor.generation });
    state.objects[id] = { id, weaponId: 'dense_payload', sourceTeam: 'player', weight: 2, originGroupId: id,
      location: { kind: 'carried', actorId, slot } };
  }
  actor.cargoIds = [...ids];
  state.cargoSlots[actorId] = [...ids];
  state.selectedCargoSlots[actorId] = 4;
  assertObjectLocationsUnique(state);
  return ids;
}

for (const health of [4, 2]) test(`enemy core shot survives same-tick ${health === 2 ? 'lethal' : 'nonlethal'} damage without changing cargo drops`, () => {
  let state = fixture();
  const { position } = placeForCoreShot(state, 'E29', 'player');
  place(state, 'P1', position.x + 1_000, position.y);
  state.actors.P1.location.roomId = state.actors.P1.currentRoomId = 'core';
  state.actors.P1.location.pathRooms = ['core'];
  state.actorFacing.P1 = { x: -1, y: 0 };
  state.actors.E29.health = health;
  state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'same-tick core fixture' } };
  const cargo = carriedFixture(state, 'E29');
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.outcome, 'enemy_win');
  assert.equal(state.castles.player.core.hit, true);
  assert.equal(state.actors.E29.health, health - 2);
  assert.equal(state.actors.E29.alive, health > 2);
  assert.equal(state.shots.filter(shot => shot.actorId === 'E29').length, 1);
  assert.equal(state.shootCooldownUntilTick.E29, PERSONAL_SHOT_COOLDOWN_TICKS);
  assert.equal(state.lastStep.events.filter(event => event.type === 'core_hit_candidate' && event.attackerId === 'E29').length, 1);
  assert.equal(state.lastStep.events.filter(event => event.type === 'actor_damaged' && event.actorId === 'E29').length, 1);
  assert.deepEqual(state.actors.E29.cargoIds, health === 2 ? [] : cargo.slice(0, 4));
  for (const [slot, id] of cargo.entries()) {
    const dropped = health === 2 || slot === 4;
    assert.equal(state.battleCases[id].location, dropped ? 'floor' : 'carried');
    assert.equal(state.objects[id].location.kind, dropped ? 'floor' : 'carried');
    assert.equal(state.cargoSlots.E29[slot], dropped ? null : id);
    if (dropped) {
      assert.deepEqual(state.battleCases[id].position, position);
      assert.equal(state.battleCases[id].autoPickupAfterTick, 30);
    }
  }
  if (health === 2) {
    assert.equal(state.actors.E29.deathCount, 1);
    assert.equal(state.actors.E29.respawnAtTick, null, 'terminal battle discards the death respawn');
  }
  assertObjectLocationsUnique(state);
});

for (const health of [4, 2]) test(`support core shot survives an earlier enemy's ${health === 2 ? 'lethal' : 'nonlethal'} shot`, () => {
  let state = fixture();
  placeForCoreShot(state, 'P2', 'enemy');
  const placeInCore = (id: string, x: number, y: number) => {
    const actor = state.actors[id];
    actor.location = { area: 'castle', castleTeam: 'enemy', roomId: 'core', pathRooms: [...state.layout.enemy.coreRouteRooms], pathGates: [...state.layout.enemy.coreRouteGates] };
    actor.currentRoomId = 'core'; actor.position = { x: Math.floor(x / 1000), y: Math.floor(y / 1000) };
    state.fixedActors[id] = { position: { x, y }, remainder: { x: 0, y: 0 } };
  };
  placeInCore('P2', 118_500, 35_500);
  placeInCore('E17', 116_500, 35_500);
  placeInCore('P1', 123_700, 39_700);
  // The leader is beyond the threat leash, so P2 moves toward the leader/core
  // rather than turning around. All positions stay on actual core-room floor.
  state.allyOrders.P2 = { kind: 'follow', generation: 0, playerGeneration: 0, issuedAtTick: 0 };
  state.actors.P1.protectedUntilTick = 100_000;
  state.actors.E17.protectedUntilTick = null;
  state.actors.P2.health = health;
  state.actorFacing.E17 = { x: 1, y: 0 };
  state.enemyDecisions.E17 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'earlier enemy shot fixture' } };
  state = stepBattle(state);
  assert.equal(state.outcome, 'player_win');
  assert.equal(state.actors.P2.health, health - 2);
  assert.equal(state.actors.P2.alive, health > 2);
  assert.equal(state.shots.filter(shot => shot.actorId === 'P2').length, 1);
  assert.equal(state.shots.filter(shot => shot.actorId === 'E17').length, 1);
  assert.equal(state.lastStep.events.filter(event => event.type === 'core_hit_candidate' && event.attackerId === 'P2').length, 1);
});

test('pre-shot capture still enforces core facing, route, gates, cooldown and action eligibility', () => {
  for (const violation of ['wrong-facing', 'closed-gate', 'missing-route', 'cooldown', 'protected', 'dead', 'zero-health', 'dash'] as const) {
    let state = fixture();
    placeForCoreShot(state, 'E29', 'player');
    state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'core eligibility fixture' } };
    if (violation === 'wrong-facing') state.actorFacing.E29 = { x: 1, y: 0 };
    if (violation === 'closed-gate') state.castles.player.gates.G7.open = false;
    if (violation === 'missing-route') state.actors.E29.location.pathGates = [];
    if (violation === 'cooldown') state.shootCooldownUntilTick.E29 = 1;
    if (violation === 'protected') state.actors.E29.protectedUntilTick = 1;
    if (violation === 'dead') state.actors.E29.alive = false;
    if (violation === 'zero-health') state.actors.E29.health = 0;
    if (violation === 'dash') state.dashes.E29 = { direction: { x: -1, y: 0 }, remainingTicks: 12, start: { ...state.fixedActors.E29.position }, damageEnabled: false };
    state = stepBattle(state);
    assert.equal(state.outcome, 'ongoing', violation);
    assert.equal(state.castles.player.core.hit, false, violation);
    assert.equal(state.lastStep.events.some(event => event.type === 'core_hit_candidate'), false, violation);
  }
});

test('shared ray inspection retains the eight-unit personal range and ordinary hit-stun', () => {
  for (const distance of [7_500, 9_000]) {
    let state = fixture();
    place(state, 'E29', 60_500 + distance, 34_500);
    state.actors.E29.protectedUntilTick = null;
    state.enemyDecisions.E29 = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'range fixture' } };
    state = stepBattle(state, input(state, { shoot: true }));
    assert.equal(state.actors.E29.health, distance < 8_000 ? 2 : 4);
    assert.equal(state.actors.P1.health, 4, 'ordinary damaged enemies do not gain a same-tick countershot');
    assert.equal(state.shots.filter(shot => shot.actorId === 'E29').length, 0);
    const shot = state.shots.find(shot => shot.actorId === 'P1')!;
    assert.ok(shot.to.x - shot.from.x <= 8_000);
  }
});

test('opposing core shots remain simultaneous when an attacker also dies in that tick', () => {
  let state = fixture();
  const { position } = placeForCoreShot(state, 'P1', 'enemy');
  placeForCoreShot(state, 'E29', 'player');
  const guard = state.actors.E17;
  guard.location = { area: 'castle', castleTeam: 'enemy', roomId: 'core', pathRooms: ['core'], pathGates: [] };
  guard.currentRoomId = 'core'; guard.protectedUntilTick = null;
  guard.position = { x: Math.floor((position.x - 2_000) / 1000), y: Math.floor(position.y / 1000) };
  state.fixedActors.E17 = { position: { x: position.x - 2_000, y: position.y } };
  state.actorFacing.E17 = { x: 1, y: 0 };
  for (const id of ['E17', 'E29']) state.enemyDecisions[id] = { generation: 0, nextDecisionTick: 100_000, intent: { kind: 'wait', reason: 'simultaneous damaged core fixture' } };
  state.actors.P1.health = 2;
  state = stepBattle(state, input(state, { shoot: true }));
  assert.equal(state.outcome, 'draw');
  assert.equal(state.actors.P1.alive, false);
  assert.equal(state.castles.player.core.hit, true);
  assert.equal(state.castles.enemy.core.hit, true);
  assert.equal(state.lastStep.events.filter(event => event.type === 'core_hit_candidate').length, 2);
  assert.equal(state.shots.filter(shot => shot.actorId === 'P1').length, 1);
  assert.equal(state.shots.filter(shot => shot.actorId === 'E29').length, 1);
});
