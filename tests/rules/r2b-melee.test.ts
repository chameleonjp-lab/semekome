import assert from "node:assert/strict";
import test from "node:test";
import { floorCell } from "../../src/actors/movement.ts";
import { createBattle, getInteraction, stepBattle } from "../../src/simulation/physical-battle.ts";
import type { BattleDirection, BattleState } from "../../src/simulation/physical-battle.ts";

const NEUTRAL: BattleDirection = { x: 0, y: 0 };

function p1Intent(state: BattleState, extra: Record<string, unknown> = {}) {
  return {
    matchId: state.matchId,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    direction: NEUTRAL,
    ...extra,
  };
}

function putActorInPlaza(state: BattleState, actorId: "P1" | "E29", point: { x: number; y: number }): void {
  const actor = state.actors[actorId];
  actor.location = { area: "plaza", pathRooms: [], pathGates: [] };
  actor.currentRoomId = "plaza";
  actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
  actor.protectedUntilTick = null;
  actor.damageImmuneUntilTick = null;
  state.fixedActors[actorId].position = { ...point };
  state.fixedActors[actorId].remainder = { x: 0, y: 0 };
  state.dashes[actorId] = undefined;
}

function keepOnlyActorsAlive(state: BattleState, aliveIds: readonly ("P1" | "E29")[]): void {
  for (const actor of Object.values(state.actors)) {
    if (aliveIds.includes(actor.id as "P1" | "E29")) continue;
    actor.alive = false;
    actor.health = 0;
    actor.respawnAtTick = 10_000;
    state.dashes[actor.id] = undefined;
  }
}

test("R2b normal contact attack damages the nearest opposing actor without dashing", () => {
  let state = createBattle({ matchId: "r2b-melee-contact", seed: 211 });
  putActorInPlaza(state, "P1", { x: 63_000, y: 35_000 });
  putActorInPlaza(state, "E29", { x: 63_500, y: 35_000 });
  keepOnlyActorsAlive(state, ["P1", "E29"]);
  const startHealth = state.actors.E29.health;
  const startPosition = { ...state.fixedActors.P1.position };

  const interaction = getInteraction(state, "P1");
  assert.equal(interaction.attackTargetId, "E29");
  const next = stepBattle(state, p1Intent(state, { attack: true }));

  assert.equal(next.actors.E29.health, startHealth - next.rules.normalContactDamage);
  assert.equal(next.rules.normalContactDamage, 2, "normal contact uses its own supplemental damage value");
  assert.equal(next.rules.dashActorDamage, 1, "dash damage remains unchanged");
  assert.deepEqual(next.fixedActors.P1.position, startPosition);
  assert.equal(next.dashes.P1, undefined);
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), true);
  assert.equal(next.lastStep.rejected.length, 0);
});

test("R2b normal contact attack cannot cross a room boundary and leaves the target unharmed", () => {
  let state = createBattle({ matchId: "r2b-melee-room-boundary", seed: 223 });
  const player = state.actors.P1;
  const enemy = state.actors.E29;
  player.location = { area: "castle", castleTeam: "player", roomId: "command", pathRooms: ["command"], pathGates: [] };
  player.currentRoomId = "command";
  enemy.location = { area: "castle", castleTeam: "player", roomId: "corridor_0", pathRooms: ["corridor_0"], pathGates: [] };
  enemy.currentRoomId = "corridor_0";
  for (const actor of [player, enemy]) {
    actor.protectedUntilTick = null;
    actor.damageImmuneUntilTick = null;
    actor.position = { x: 50, y: 50 };
    state.fixedActors[actor.id].position = { x: 50_000, y: 50_000 };
    state.fixedActors[actor.id].remainder = { x: 0, y: 0 };
    state.dashes[actor.id] = undefined;
  }
  keepOnlyActorsAlive(state, ["P1", "E29"]);
  const startHealth = enemy.health;

  assert.equal(getInteraction(state, "P1").attackTargetId, undefined);
  const next = stepBattle(state, p1Intent(state, { attack: true }));

  assert.equal(next.actors.E29.health, startHealth);
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), false);
  assert.match(next.lastStep.rejected[0]?.detail ?? "", /no adjacent enemy actor/);
});

test("R2b normal contact attack cannot hit through a closed gate", () => {
  let state = createBattle({ matchId: "r2b-melee-wall", seed: 225 });
  const player = state.actors.P1;
  const enemy = state.actors.E29;
  for (const actor of [player, enemy]) {
    actor.location = { area: "castle", castleTeam: "player", roomId: "corridor_0", pathRooms: ["corridor_0"], pathGates: [] };
    actor.currentRoomId = "corridor_0";
    actor.protectedUntilTick = null;
    actor.damageImmuneUntilTick = null;
  }
  player.position = { x: floorCell(47_400), y: floorCell(33_500) };
  enemy.position = { x: floorCell(46_900), y: floorCell(33_500) };
  state.fixedActors.P1.position = { x: 47_400, y: 33_500 };
  state.fixedActors.E29.position = { x: 46_900, y: 33_500 };
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
  state.fixedActors.E29.remainder = { x: 0, y: 0 };
  state.dashes.P1 = undefined;
  state.dashes.E29 = undefined;
  keepOnlyActorsAlive(state, ["P1", "E29"]);
  const startHealth = enemy.health;

  assert.equal(getInteraction(state, "P1").attackTargetId, undefined);
  const next = stepBattle(state, p1Intent(state, { attack: true }));

  assert.equal(next.actors.E29.health, startHealth);
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), false);
});

test("R2b normal contact attack respects spawn protection and damage invulnerability", () => {
  let state = createBattle({ matchId: "r2b-melee-protection", seed: 227 });
  putActorInPlaza(state, "P1", { x: 63_000, y: 35_000 });
  putActorInPlaza(state, "E29", { x: 63_500, y: 35_000 });
  keepOnlyActorsAlive(state, ["P1", "E29"]);
  state.actors.E29.protectedUntilTick = state.tick + 10;

  const protectedTarget = stepBattle(state, p1Intent(state, { attack: true }));
  assert.equal(protectedTarget.actors.E29.health, state.actors.E29.health);
  assert.equal(protectedTarget.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), false);

  protectedTarget.actors.E29.protectedUntilTick = null;
  const hit = stepBattle(protectedTarget, p1Intent(protectedTarget, { attack: true }));
  const healthAfterHit = hit.actors.E29.health;
  const immuneRepeat = stepBattle(hit, p1Intent(hit, { attack: true }));
  assert.equal(immuneRepeat.actors.E29.health, healthAfterHit);
  assert.equal(immuneRepeat.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), false);
  assert.match(immuneRepeat.lastStep.rejected[0]?.detail ?? "", /no adjacent enemy actor/);
});

test("R2b normal contact attack never creates a core victory contact", () => {
  let state = createBattle({ matchId: "r2b-melee-core-boundary", seed: 229 });
  putActorInPlaza(state, "P1", { x: 63_000, y: 35_000 });
  putActorInPlaza(state, "E29", { x: 63_500, y: 35_000 });
  keepOnlyActorsAlive(state, ["P1", "E29"]);
  const next = stepBattle(state, p1Intent(state, { attack: true }));

  assert.equal(next.outcome, "ongoing");
  assert.equal(next.castles.player.core.hit, false);
  assert.equal(next.castles.enemy.core.hit, false);
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:core_contact"), false);
});

test("R2b normal contact attack cannot be combined with a dash", () => {
  let state = createBattle({ matchId: "r2b-melee-dash-conflict", seed: 233 });
  putActorInPlaza(state, "P1", { x: 63_000, y: 35_000 });
  putActorInPlaza(state, "E29", { x: 63_500, y: 35_000 });
  keepOnlyActorsAlive(state, ["P1", "E29"]);
  const startHealth = state.actors.E29.health;

  const next = stepBattle(state, p1Intent(state, { attack: true, dash: { x: 1, y: 0 } }));

  assert.equal(next.actors.E29.health, startHealth);
  assert.equal(next.dashes.P1, undefined);
  assert.match(next.lastStep.rejected[0]?.detail ?? "", /cannot be combined/);
});
