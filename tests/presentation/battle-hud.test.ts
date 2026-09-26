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
