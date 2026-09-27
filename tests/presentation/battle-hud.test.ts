import assert from 'node:assert/strict';
import test from 'node:test';
import { PART_IDS } from '../../src/domain/types.ts';
import { createBattle } from '../../src/simulation/physical-battle.ts';
import { actorLocationName, actorStatusName, battleHint, battleMapLabel, partDisplayName } from '../../src/presentation/battle-hud.ts';

function fixture() {
  return createBattle({ matchId: 'battle-hud-review', seed: 48 });
}

test('location, hint, and accessible map label follow the actor between both castles and plaza', () => {
  const state = fixture();
  const actor = state.actors.P1;
  actor.currentRoomId = 'central_corridor';
  actor.location = { area: 'castle', castleTeam: 'player', roomId: actor.currentRoomId, pathRooms: [], pathGates: [] };
  const homeRoom = state.layout.home.rooms.find((room) => room.id === actor.currentRoomId)!.label;
  assert.equal(actorLocationName(state, actor), `自陣 · ${homeRoom}`);
  assert.match(battleMapLabel(state, actor), /自陣 · .*城内図/);
  assert.match(battleHint(state, actor, undefined, false, false), /自陣の弾薬庫/);

  actor.location = { area: 'castle', castleTeam: 'enemy', roomId: actor.currentRoomId, pathRooms: [], pathGates: [] };
  const enemyRoom = state.layout.enemy.rooms.find((room) => room.id === actor.currentRoomId)!.label;
  assert.equal(actorLocationName(state, actor), `敵陣 · ${enemyRoom}`);
  assert.match(battleHint(state, actor, 'pickup', false, false), /敵陣.*床の弾.*拾えます/);
  assert.match(battleHint(state, actor, undefined, true, true), /敵陣.*弾を置けます.*砲台操作と修理は自陣/);

  actor.currentRoomId = 'plaza';
  actor.location = { area: 'plaza', pathRooms: [], pathGates: [] };
  assert.equal(actorLocationName(state, actor), '広場');
  assert.match(battleMapLabel(state, actor), /広場と両城の外観/);
  assert.match(battleHint(state, actor, 'pickup', false, false), /広場.*拾えます/);
  assert.match(battleHint(state, actor, undefined, true, true), /弾を広場に置けます/);
});

test('plaza hint reports the live guard boundary before and after deployment', () => {
  const state = fixture();
  const actor = state.actors.P1;
  actor.currentRoomId = 'plaza';
  actor.location = { area: 'plaza', pathRooms: [], pathGates: [] };

  assert.match(battleHint(state, actor, undefined, false, false), /防衛者が出動中/);

  state.plaza.guardDeployments.enemy = {
    dispatchedAtTick: state.tick,
    guardGenerations: { E25: 0, E26: 0, E27: 0 },
  };
  assert.match(battleHint(state, actor, undefined, false, false), /残り3人/);
  for (const id of ['E25', 'E26', 'E27'] as const) {
    state.actors[id].alive = false;
    state.actors[id].health = 0;
    state.actors[id].respawnAtTick = 9_999;
  }
  assert.match(battleHint(state, actor, undefined, false, false), /防衛者を突破しました.*敵城側の入口へ進めます/);
});

test('death projects spectator status with death origin and a pause-aware respawn clock', () => {
  const state = fixture();
  const actor = state.actors.P1;
  actor.currentRoomId = 'repair';
  actor.location = { area: 'castle', castleTeam: 'enemy', roomId: 'repair', pathRooms: [], pathGates: [] };
  actor.alive = false;
  actor.health = 0;
  actor.respawnAtTick = state.tick + 5 * state.rules.ticksPerSecond;
  const room = state.layout.enemy.rooms.find((candidate) => candidate.id === 'repair')!.label;
  assert.match(actorStatusName(state, actor), new RegExp(`^観戦 · 敵陣 · ${room}で撃破 · 復活まで 0:05$`));
  assert.match(battleMapLabel(state, actor), /観戦中。死亡地点：敵陣/);
  assert.match(battleHint(state, actor, undefined, false, false), /戦況は進行しています.*復活まで 0:05/);

  state.phase = 'paused';
  assert.match(battleHint(state, actor, undefined, false, false), /一時停止中のため戦況も止まっています.*復活まで 0:05/);
});

test('exterior display names do not collide with player actor IDs', () => {
  assert.deepEqual(PART_IDS.map(partDisplayName), [
    '外装1', '外装2', '外装3', '外装4', '外装5', '外装6', '外装7',
  ]);
});

test('core hints distinguish actual enemy core contact from own core defense', () => {
  const state = fixture();
  const actor = state.actors.P1;
  actor.currentRoomId = 'core';
  actor.location = { area: 'castle', castleTeam: 'enemy', roomId: 'core', pathRooms: [], pathGates: [] };
  assert.match(battleHint(state, actor, undefined, false, false), /核そのものへ突進.*入室・歩行/);
  actor.location.castleTeam = 'player';
  assert.match(battleHint(state, actor, undefined, false, false), /自陣.*敗北.*自分の核/);
});

test('ended spectator hint never promises a canceled respawn', () => {
  const state = fixture();
  state.phase = 'ended';
  state.actors.P1.alive = false;
  assert.match(battleHint(state, state.actors.P1, undefined, false, false), /戦闘は終了/);
  assert.doesNotMatch(battleHint(state, state.actors.P1, undefined, false, false), /復活まで/);
});
