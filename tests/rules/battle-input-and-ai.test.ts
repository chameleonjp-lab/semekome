import assert from "node:assert/strict";
import test from "node:test";
import { createBattle, cloneBattle, stepBattle, assertBattleConsistent } from "../../src/simulation/battle.ts";
import { chooseEnemyIntent, observeEnemy, updateEnemyDecisions } from "../../src/simulation/enemy-rules.ts";
import { executeActorCommand } from "../../src/simulation/battle-actions.ts";
import { stepWorld } from "../../src/simulation/world.ts";
import { atTurret, caseAtActor, command, flight, readyShot } from "./battle-helpers.ts";

test("public commands reject injected damage, teleportation, core hits, NPC impersonation and malformed input", () => {
  const b = createBattle();
  atTurret(b, "P1");
  caseAtActor(b, "case", "standard_slug");
  const next = stepBattle(b, [null, 3, [], {},
    command(b, "damage_actor", { amount: 99 }), command(b, "damage_part", { team: "enemy", amount: 999 }),
    command(b, "core_attack", { hit: true, targetTeam: "enemy" }), command(b, "move_actor", { toRoomId: "core" }),
    command(b, "fly_object", { objectId: "case" }), command(b, "pickup", { actorId: "E01", objectId: "case" }),
    command(b, "pickup", { actorId: "P2", objectId: "case" }), command(b, "pickup", { generation: undefined, objectId: "case" }),
    command(b, "pickup", { generation: 10, objectId: "case" }), command(b, "pickup", { matchId: "old", objectId: "case" }),
    command(b, "aim", { turretId: "__proto__", route: "direct", partId: "P1" }),
    command(b, "aim", { turretId: "T1", route: "unknown", partId: "P1" }),
    command(b, "aim", { turretId: "T1", route: "direct", partId: "constructor" }),
    { kind: "visibility", visible: "true", matchId: b.world.matchId },
  ]);
  assert.equal(next.lastCombatStep.rejected.length, 18);
  assert.equal(next.world.actors.P1.health, 4);
  assert.deepEqual(next.world.castles, b.world.castles);
  assert.equal(next.world.objects.case.location.kind, "floor");
  assert.equal(Object.keys(next.world.projectiles).length, 0);
  assert.equal(next.world.phase, "running");
});

test("pickup checks actual distance, castle, room, slots and weight; two heavy cases cannot be carried", () => {
  const b = createBattle();
  atTurret(b, "P1");
  caseAtActor(b, "a", "dense_payload");
  caseAtActor(b, "b", "dense_payload");
  caseAtActor(b, "c", "standard_slug");
  const next = stepBattle(b, [command(b, "pickup", { objectId: "a" }), command(b, "pickup", { objectId: "b" }), command(b, "pickup", { objectId: "c" })]);
  assert.deepEqual(next.world.actors.P1.cargoIds, ["a", "c"]);
  assert.equal(next.lastCombatStep.rejected[0]?.reason, "carry_limit");
  for (const mismatch of ["distance", "room", "team"]) {
    const invalid = cloneBattle(b);
    const location = invalid.world.objects.a.location;
    assert.equal(location.kind, "floor");
    if (location.kind !== "floor") throw new Error("fixture");
    if (mismatch === "distance") location.position.x += 2;
    if (mismatch === "room") location.roomId = "central_corridor";
    if (mismatch === "team") location.team = "enemy";
    assert.equal(stepBattle(invalid, [command(invalid, "pickup", { objectId: "a" })]).lastCombatStep.rejected[0]?.reason, "out_of_range");
  }
});

test("chosen object/slot does not retarget; full queues retain cargo; repair reservation cannot load", () => {
  const b = createBattle();
  atTurret(b, "P1");
  for (const id of ["left", "right", "extra"]) caseAtActor(b, id, "standard_slug");
  assert.equal(executeActorCommand(b, command(b, "pickup", { objectId: "left" })), null);
  assert.equal(executeActorCommand(b, command(b, "pickup", { objectId: "right" })), null);
  assert.equal(executeActorCommand(b, command(b, "load", { objectId: "right", turretId: "T1" })), null);
  assert.deepEqual(b.world.objects.left.location, { kind: "carried", actorId: "P1", slot: 0 });
  assert.equal(executeActorCommand(b, command(b, "load", { objectId: "right", turretId: "T1" })), "not_unreserved_cargo");
  assert.equal(b.world.objects.left.location.kind, "carried");
  assert.equal(executeActorCommand(b, command(b, "load", { objectId: "left", turretId: "T1" })), null);
  assert.equal(executeActorCommand(b, command(b, "pickup", { objectId: "extra" })), null);
  assert.equal(executeActorCommand(b, command(b, "load", { objectId: "extra", turretId: "T1" })), "queue_full");
  b.world = stepWorld(b.world, { kind: "reserve_object", matchId: b.world.matchId, actorId: "P1", generation: 0, objectId: "extra", reservationId: "repair" });
  assert.equal(executeActorCommand(b, command(b, "load", { objectId: "extra", turretId: "T2" })), "out_of_range");
  atTurret(b, "P1", "T2");
  assert.equal(executeActorCommand(b, command(b, "load", { objectId: "extra", turretId: "T2" })), "not_unreserved_cargo");
  assert.equal(b.world.objects.extra.location.kind, "reserved-carried");
  assertBattleConsistent(b);
});

test("operator claims are exclusive; supports can operate internally but cannot be impersonated by public input", () => {
  const b = createBattle();
  atTurret(b, "P1"); atTurret(b, "P2");
  assert.equal(executeActorCommand(b, command(b, "operate", { turretId: "T1" })), null);
  assert.equal(executeActorCommand(b, command(b, "operate", { actorId: "P2", turretId: "T1" })), "operator_occupied");
  assert.equal(executeActorCommand(b, command(b, "release")), null);
  assert.equal(executeActorCommand(b, command(b, "operate", { actorId: "P2", turretId: "T1" })), null);
  assert.equal(b.turrets.player.T1.operator?.actorId, "P2");
});

test("paused/hidden clocks freeze flights and AI; visible needs explicit resume and cannot catch up", () => {
  const b = createBattle();
  flight(b, "a", "standard_slug", "player", 0);
  let next = stepBattle(b, [{ kind: "visibility", visible: false, matchId: b.world.matchId }]);
  for (let i = 0; i < 100; i++) next = stepBattle(next);
  assert.equal(next.world.tick, 0);
  assert.equal(next.flights.a.progress, 0);
  assert.deepEqual(next.enemyDecisions, {});
  next = stepBattle(next, [{ kind: "resume", matchId: b.world.matchId }]);
  assert.equal(next.world.phase, "paused");
  next = stepBattle(next, [{ kind: "visibility", visible: true, matchId: b.world.matchId }]);
  assert.equal(next.world.phase, "paused");
  assert.equal(next.world.tick, 0);
  next = stepBattle(next, [{ kind: "resume", matchId: b.world.matchId }]);
  assert.equal(next.world.tick, 1);
  assert.equal(next.flights.a.progress, 20);
  const freeze = stepBattle(next, [{ kind: "pause", matchId: b.world.matchId }, { kind: "resume", matchId: b.world.matchId }]);
  assert.equal(freeze.world.tick, 1);
  assert.equal(freeze.flights.a.progress, 20);
});

test("spectating player cannot command but world and exact respawn deadline continue", () => {
  let b = createBattle();
  atTurret(b, "P1");
  caseAtActor(b, "a", "standard_slug");
  b.world = stepWorld(b.world, { kind: "damage_actor", matchId: b.world.matchId, actorId: "P1", generation: 0, amount: 4 });
  flight(b, "other-shot", "standard_slug", "enemy", 0);
  b = stepBattle(b, [command(b, "pickup", { objectId: "a" })]);
  assert.equal(b.lastCombatStep.rejected[0]?.reason, "dead_actor");
  assert.equal(b.flights["other-shot"].progress, 20);
  while (b.world.tick < 300) b = stepBattle(b);
  assert.equal(b.world.actors.P1.alive, false);
  b = stepBattle(b);
  assert.equal(b.world.actors.P1.alive, true);
  assert.equal(b.world.actors.P1.generation, 1);
  assert.equal(b.world.actors.P1.currentRoomId, "respawn");
  assert.equal(stepBattle(b, [command(b, "operate", { turretId: "T1" })]).lastCombatStep.rejected[0]?.reason, "protected_actor");
});

test("enemy role decisions differ locally without revealing unseen player or future supply", () => {
  const b = createBattle();
  const shooter = b.world.actors.E01, guard = b.world.actors.E05, carrier = b.world.actors.E09;
  for (const id of ["E01", "E05", "E09", "E17"]) assert.deepEqual(observeEnemy(b, b.world.actors[id]).threats, []);
  const hidden = cloneBattle(b);
  hidden.world.actors.P1.position = { x: 0, y: 0 };
  caseAtActor(hidden, "unknown-supply", "dense_payload", "P1");
  assert.deepEqual(observeEnemy(b, shooter), observeEnemy(hidden, hidden.world.actors.E01));
  const shooterObservation = observeEnemy(b, shooter);
  assert.deepEqual(chooseEnemyIntent({ ...shooterObservation, threats: ["P1"] }), { kind: "defend", targetId: "P1" });
  assert.deepEqual(chooseEnemyIntent({ ...observeEnemy(b, guard), threats: ["P1"], currentRoomId: "central_corridor" }), { kind: "move_goal", roomId: guard.homeRoomId, purpose: "return" });
  assert.deepEqual(chooseEnemyIntent({ ...observeEnemy(b, carrier), threats: ["P1"] }), { kind: "retreat", awayFromId: "P1" });
  assert.deepEqual(chooseEnemyIntent({ ...observeEnemy(b, carrier), cargo: ["real-case"] }), { kind: "wait", reason: "delivery_reservation_required" });
  assert.equal(chooseEnemyIntent(observeEnemy(b, b.world.actors.E25)).kind, "move_goal");
  const assault = chooseEnemyIntent(observeEnemy(b, b.world.actors.E29));
  assert.equal(assault.kind === "move_goal" && assault.purpose, "assault");
});

test("shooter AI picks up, loads, operates through the same validators without creating ammunition", () => {
  let b = createBattle();
  atTurret(b, "E01");
  caseAtActor(b, "real-case", "standard_slug", "E01");
  b = stepBattle(b);
  assert.equal(b.world.objects["real-case"].location.kind, "carried");
  while (b.world.tick <= 18) b = stepBattle(b);
  assert.equal(b.world.objects["real-case"].location.kind, "queue");
  while (b.world.tick <= 48) b = stepBattle(b);
  assert.equal(b.world.objects["real-case"].location.kind, "flying");
  assert.equal(Object.keys(b.world.objects).length, 1);
  assert.equal(Object.keys(b.world.actors).length, 33);
});

test("simultaneous carriers cannot duplicate one actual case, and movement goals never teleport", () => {
  const b = createBattle();
  b.world.actors.E10.position = { ...b.world.actors.E09.position };
  caseAtActor(b, "only-case", "standard_slug", "E09");
  const next = stepBattle(b);
  assert.deepEqual(next.world.actors.E09.cargoIds, ["only-case"]);
  assert.deepEqual(next.world.actors.E10.cargoIds, []);
  assert.equal(next.world.objects["only-case"].location.kind, "carried");
  for (const actor of Object.values(b.world.actors)) assert.deepEqual(next.world.actors[actor.id].position, actor.position);
  assertBattleConsistent(next);
});

test("AI cadence does not delay operator invalidation or enemy respawn; generation never reuses a job", () => {
  let b = createBattle({ difficulty: "easy" });
  readyShot(b, "first", "E01");
  readyShot(b, "second", "E01");
  b = stepBattle(b);
  assert.equal(b.enemyDecisions.E01.nextDecisionTick, 36);
  b.world = stepWorld(b.world, { kind: "damage_actor", matchId: b.world.matchId, actorId: "E01", generation: 0, amount: 4 });
  b = stepBattle(b);
  assert.equal(b.turrets.enemy.T1.operator, null);
  assert.equal(b.enemyDecisions.E01, undefined);
  while (b.world.tick < 1201) b = stepBattle(b);
  assert.equal(b.world.actors.E01.alive, false);
  b = stepBattle(b);
  assert.equal(b.world.actors.E01.alive, true);
  assert.equal(b.world.actors.E01.generation, 1);
  assert.equal(b.enemyDecisions.E01, undefined);
  assert.equal(b.world.objects.second.location.kind, "queue");
});

test("self-defense selection releases the shooter's station rather than firing while defending", () => {
  const b = createBattle();
  readyShot(b, "ammo", "E01");
  b.world.actors.P1.location = structuredClone(b.world.actors.E01.location);
  b.world.actors.P1.currentRoomId = b.world.actors.E01.currentRoomId;
  b.world.actors.P1.position = { ...b.world.actors.E01.position };
  updateEnemyDecisions(b);
  assert.equal(b.enemyDecisions.E01.intent.kind, "defend");
  assert.equal(b.turrets.enemy.T1.operator, null);
});

test("render-rate grouping is irrelevant, inputs do not mutate prior state, ended battles freeze", () => {
  const initial = createBattle({ seed: 42, matchId: "replay", rules: { matchLimitTicks: 360 } });
  readyShot(initial, "p", "P1");
  readyShot(initial, "e", "E01");
  const before = cloneBattle(initial);
  const replay = (rate: number) => {
    let b = cloneBattle(initial), accumulator = 0;
    for (let frame = 0; frame < rate * 6; frame++) {
      accumulator += 60;
      while (accumulator >= rate) { b = stepBattle(b); accumulator -= rate; }
    }
    return b;
  };
  const result = replay(30);
  assert.deepEqual(replay(60), result);
  assert.deepEqual(replay(120), result);
  assert.deepEqual(initial, before);
  assert.equal(result.world.outcome, "draw");
  assert.deepEqual(result.enemyDecisions, {});
  const frozen = stepBattle(result, [command(result, "operate", { turretId: "T1" })]);
  assert.deepEqual(frozen.flights, result.flights);
  assert.equal(frozen.world.tick, 360);
  assert.equal(frozen.lastCombatStep.rejected[0]?.reason, "ended");
});
