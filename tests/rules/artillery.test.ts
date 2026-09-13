import assert from "node:assert/strict";
import test from "node:test";
import cases from "../../docs/plans/current/ORIGINAL_CASES.json" with { type: "json" };
import rules from "../../docs/plans/current/INITIAL_RULES.json" with { type: "json" };
import { compileWeapons, WEAPONS } from "../../src/content/weapons.ts";
import { assertBattleConsistent, canSupplyProduce, cloneBattle, createBattle, movementMultiplier, stepBattle } from "../../src/simulation/battle.ts";
import { executeActorCommand } from "../../src/simulation/battle-actions.ts";
import { stepWorld } from "../../src/simulation/world.ts";
import { openAllGates } from "./helpers.ts";
import { atTurret, caseAtActor, command, flight, readyShot } from "./battle-helpers.ts";

test("all eight definitions match source; new IDs reuse rules and invalid effects fail closed", () => {
  assert.equal(Object.keys(WEAPONS).length, 8);
  for (const row of cases.cases) {
    const compiled = WEAPONS[row.id];
    assert.deepEqual([compiled.weight, compiled.durability, compiled.speed, compiled.damage], [row.weight, row.intercept_hits, row.flight_speed, row.part_damage]);
  }
  assert.equal(compileWeapons([{ ...cases.cases[0], id: "another_slug", flight_speed: 25 }]).another_slug.speed, 25);
  for (const patch of [{ effect: "unknown" }, { flight_speed: NaN }, { weight: 4 }, { part_damage: -1 }, { id: "constructor" }]) {
    assert.throws(() => compileWeapons([{ ...cases.cases[0], ...patch }]));
  }
  const split = cases.cases.find(row => row.id === "split_payload")!;
  assert.throws(() => compileWeapons([{ ...split, part_damage: 30 }]));
  assert.throws(() => compileWeapons([cases.cases[0], cases.cases[0]]));
  assert.equal(rules.cannon.team_profiles.player.requires_live_operator_at_launch, true);
});

for (const left of cases.cases) for (const right of cases.cases) {
  test(`interception ${left.id} / ${right.id}: both spend exactly one durability`, () => {
    const b = createBattle();
    flight(b, "left", left.id, "player", 3600);
    flight(b, "right", right.id, "enemy", 3600);
    const next = stepBattle(b);
    assert.equal(next.flights.left?.durability ?? 0, left.intercept_hits - 1);
    assert.equal(next.flights.right?.durability ?? 0, right.intercept_hits - 1);
    assert.equal(next.lastCombatStep.events.filter(e => e.kind === "intercept").length, 1);
    assert.equal(next.lastCombatStep.events.filter(e => e.kind === "split").length, 0);
    assertBattleConsistent(next);
  });
}

test("swept contact cannot tunnel; same pair does not hit twice", () => {
  const b = createBattle();
  flight(b, "left", "breach_lance", "player", 3599);
  flight(b, "right", "breach_lance", "enemy", 3599);
  let next = stepBattle(b);
  assert.equal(next.flights.left.durability, 2);
  next = stepBattle(next);
  assert.equal(next.flights.left.durability, 2);
  assert.equal(next.lastCombatStep.events.length, 0);
});

test("different routes and friendly projectiles do not intercept", () => {
  const b = createBattle();
  flight(b, "left", "standard_slug", "player", 3599);
  flight(b, "right", "standard_slug", "enemy", 3599, "detour");
  flight(b, "friend", "standard_slug", "player", 3599);
  const next = stepBattle(b);
  assert.equal(Object.keys(next.flights).length, 3);
  assert.equal(next.lastCombatStep.events.length, 0);
});

test("contacts resolve by time then stable IDs, independent of insertion order", () => {
  const b = createBattle();
  flight(b, "left", "standard_slug", "player", 3590);
  flight(b, "late", "standard_slug", "enemy", 3590);
  flight(b, "early", "standard_slug", "enemy", 3600);
  const reverse = cloneBattle(b);
  reverse.flights = Object.fromEntries(Object.entries(reverse.flights).reverse());
  const next = stepBattle(b);
  assert.equal(next.flights.early, undefined);
  assert.ok(next.flights.late);
  assert.deepEqual(next, stepBattle(reverse));
  const tie = createBattle();
  flight(tie, "player", "standard_slug", "player", 3600);
  flight(tie, "enemy-b", "standard_slug", "enemy", 3600);
  flight(tie, "enemy-a", "standard_slug", "enemy", 3600);
  const tied = stepBattle(tie);
  assert.ok(tied.flights["enemy-b"]);
  assert.equal(tied.flights["enemy-a"], undefined);
});

test("pickup -> aim -> load -> operate -> launch -> exterior impact uses real objects and exact flight clock", () => {
  let b = createBattle();
  atTurret(b, "P1");
  caseAtActor(b, "case", "standard_slug");
  b = stepBattle(b, [command(b, "pickup", { objectId: "case" }), command(b, "aim", { turretId: "T1", route: "direct", partId: "P4" }), command(b, "load", { objectId: "case", turretId: "T1" }), command(b, "operate", { turretId: "T1" })]);
  const id = Object.keys(b.flights)[0];
  assert.equal(b.flights[id].progress, 0);
  assert.equal(b.world.objects.case.location.kind, "flying");
  while (b.world.tick < 360) b = stepBattle(b);
  assert.equal(b.world.castles.enemy.exterior.P4.health, 50);
  b = stepBattle(b);
  assert.equal(b.world.castles.enemy.exterior.P4.health, 36);
  assert.equal(b.world.objects.case.location.kind, "consumed");
  assert.equal(b.world.outcome, "ongoing");
});

test("loaded route and target stay captured after aim changes; detour takes 468 ticks", () => {
  let b = createBattle();
  readyShot(b, "a");
  b.queued.a = { route: "detour", partId: "P4" };
  b = stepBattle(b, [command(b, "aim", { turretId: "T1", route: "direct", partId: "P6" })]);
  const id = Object.keys(b.flights)[0];
  assert.equal(b.flights[id].route, "detour");
  while (b.world.tick < 468) b = stepBattle(b);
  assert.equal(b.world.castles.enemy.exterior.P4.health, 50);
  b = stepBattle(b);
  assert.equal(b.world.castles.enemy.exterior.P4.health, 36);
  assert.equal(b.world.castles.enemy.exterior.P6.health, 50);
});

test("same-tick impacts use one target snapshot; surplus never spills to another part", () => {
  const b = createBattle();
  b.world.castles.enemy.exterior.P1.health = 10;
  flight(b, "a", "standard_slug", "player", 7199);
  flight(b, "b", "standard_slug", "player", 7199);
  const next = stepBattle(b);
  assert.equal(next.world.castles.enemy.exterior.P1.health, 0);
  assert.equal(next.world.castles.enemy.exterior.P2.health, 50);
  assert.deepEqual(next.world.castles.enemy.openGateIds, ["G1"]);
  assert.deepEqual(next.lastCombatStep.events.filter(e => e.kind === "impact").map(e => e.partId), ["P1", "P1"]);
});

test("previously destroyed target falls back to lowest surviving part", () => {
  const b = createBattle();
  b.world = stepWorld(b.world, { kind: "damage_part", matchId: b.world.matchId, team: "enemy", partId: "P4", amount: 50, source: "projectile" });
  flight(b, "a", "dense_payload", "player", 7199, "direct", "P4");
  const next = stepBattle(b);
  assert.equal(next.world.castles.enemy.exterior.P1.health, 20);
  assert.deepEqual(next.world.castles.enemy.openGateIds, ["G1"]);
});

test("all exterior destroyed still allows effects but never a projectile core victory", () => {
  const b = createBattle();
  b.world = openAllGates(b.world, "enemy");
  flight(b, "normal", "standard_slug", "player", 7199);
  flight(b, "effect", "disruption_pack", "player", 7199);
  const next = stepBattle(b);
  assert.equal(next.world.outcome, "ongoing");
  assert.equal(next.world.castles.enemy.core.hit, false);
  assert.equal(next.supplyStops.enemy.disruptedUntil, 360);
  assert.ok(next.lastCombatStep.events.filter(e => e.kind === "impact").every(e => e.damage === 0 && e.partId === null));
});

test("split conserves damage, origin and target; children wait a tick and do not split again", () => {
  const b = createBattle();
  flight(b, "parent", "split_payload", "player", 3590, "direct", "P4");
  let next = stepBattle(b);
  const children = Object.values(next.flights);
  assert.equal(children.length, 3);
  assert.equal(children.reduce((sum, f) => sum + f.damage, 0), 12);
  assert.deepEqual(children.map(f => f.progress), [3606, 3486, 3366]);
  assert.ok(children.every(f => f.bornTick === 0 && f.partId === "P4"));
  assert.equal(next.world.objects.parent.location.kind, "consumed");
  assert.ok(children.every(f => next.world.objects[f.id].originGroupId === "parent"));
  next = stepBattle(next);
  assert.deepEqual(Object.values(next.flights).map(f => f.progress), [3622, 3502, 3382]);
  while (Object.keys(next.flights).length) next = stepBattle(next);
  assert.equal(next.world.castles.enemy.exterior.P4.health, 38);
});

test("split at capacity retains parent, does not retry or delete unrelated shots", () => {
  const b = createBattle();
  flight(b, "parent", "split_payload", "player", 3590);
  for (let i = 0; i < 95; i++) flight(b, `other-${i}`, "screen_panel", "player", 0);
  let next = stepBattle(b);
  assert.equal(Object.keys(next.flights).length, 96);
  assert.equal(next.flights.parent.splitAttempted, true);
  assert.ok(next.lastCombatStep.events.some(e => e.kind === "split_blocked"));
  next.flights["other-0"].progress = 7199;
  next.flights["other-1"].progress = 7199;
  next = stepBattle(next);
  assert.equal(Object.keys(next.flights).length, 94);
  assert.ok(next.flights.parent);
  assert.ok(!next.lastCombatStep.events.some(e => e.kind === "split"));
});

test("all four enemy turrets share 48 ticks and rotate ready turrets", () => {
  let b = createBattle();
  for (let i = 1; i <= 4; i++) readyShot(b, `ammo-${i}`, `E0${i}`, `T${i}`);
  const launches: Array<{ tick: number; turretId: string }> = [];
  for (let i = 0; i <= 144; i++) {
    b = stepBattle(b);
    for (const e of b.lastCombatStep.events) if (e.kind === "launch") launches.push(e);
  }
  assert.deepEqual(launches.map(e => [e.tick, e.turretId]), [[0, "T1"], [48, "T2"], [96, "T3"], [144, "T4"]]);
});

test("no operator, wrong operator, distance, protection and equipment stop launch without losing queued cases", () => {
  for (const condition of ["absent", "dead", "distant", "protected", "disabled", "restoration", "stale"] as const) {
    const b = createBattle();
    readyShot(b, "ammo");
    const actor = b.world.actors.P1;
    if (condition === "absent") b.turrets.player.T1.operator = null;
    if (condition === "dead") actor.alive = false;
    if (condition === "distant") actor.position.x += 2;
    if (condition === "protected") actor.protectedUntilTick = 60;
    if (condition === "disabled") b.turrets.player.T1.disabledUntilTick = 480;
    if (condition === "restoration") b.turrets.player.T1.disabledUntilTick = 0;
    if (condition === "stale") b.turrets.player.T1.operator!.generation++;
    const next = stepBattle(b);
    assert.equal(Object.keys(next.flights).length, 0, condition);
    assert.equal(next.world.objects.ammo.location.kind, "queue", condition);
  }
  const b = createBattle();
  atTurret(b, "E05");
  assert.equal(executeActorCommand(b, command(b, "operate", { actorId: "E05", turretId: "T1" })), "not_operator");
});

test("dead shooter does not erase its existing flight or allow its next queued shot", () => {
  let b = createBattle();
  readyShot(b, "first", "E01");
  readyShot(b, "second", "E01");
  b = stepBattle(b);
  const first = Object.keys(b.flights)[0];
  b.world = stepWorld(b.world, { kind: "damage_actor", matchId: b.world.matchId, actorId: "E01", generation: 0, amount: 4 });
  while (b.world.tick <= 48) b = stepBattle(b);
  assert.ok(b.flights[first]);
  assert.equal(b.world.objects.second.location.kind, "queue");
  assert.equal(b.turrets.enemy.T1.operator, null);
  assert.equal(b.enemyDecisions.E01, undefined);
});

test("empty launch slots are not banked and projectile cap preserves real queue", () => {
  let b = stepBattle(createBattle());
  readyShot(b, "ready-later");
  while (b.world.tick < 48) b = stepBattle(b);
  assert.equal(Object.keys(b.flights).length, 0);
  b = stepBattle(b);
  assert.equal(Object.keys(b.flights).length, 1);
  const full = createBattle();
  readyShot(full, "waiting");
  for (let i = 0; i < 96; i++) flight(full, `f${i}`, "screen_panel", "player", 0);
  const next = stepBattle(full);
  assert.equal(next.world.objects.waiting.location.kind, "queue");
  assert.equal(Object.keys(next.flights).length, 96);
});

test("disruption does not extend, has exact immunity, and is independent of equipment", () => {
  let b = createBattle();
  flight(b, "first", "disruption_pack", "player", 7199);
  b = stepBattle(b);
  flight(b, "second", "disruption_pack", "player", 7199);
  b = stepBattle(b);
  assert.deepEqual(b.supplyStops.enemy, { disruptedUntil: 360, immuneUntil: 600, equipmentDisabledUntil: null });
  assert.equal(canSupplyProduce(b, "enemy"), false);
  while (b.world.tick < 360) b = stepBattle(b);
  assert.equal(canSupplyProduce(b, "enemy"), true);
  b.supplyStops.enemy.equipmentDisabledUntil = 480;
  assert.equal(canSupplyProduce(b, "enemy"), false);
  while (b.world.tick < 599) b = stepBattle(b);
  assert.equal(canSupplyProduce(b, "enemy"), true);
  flight(b, "immune", "disruption_pack", "player", 7199);
  b = stepBattle(b);
  assert.equal(b.supplyStops.enemy.disruptedUntil, 360);
  flight(b, "after", "disruption_pack", "player", 7199);
  b = stepBattle(b);
  assert.equal(b.supplyStops.enemy.disruptedUntil, 960);
});

test("slow zone samples apply to either actor team, expire and replace by launch team", () => {
  let b = createBattle();
  flight(b, "slow", "adhesive_pod", "player", 7199);
  b = stepBattle(b);
  const sample = { castleTeam: "enemy" as const, roomId: "central_corridor", position: { x: 2, y: 35 } };
  assert.equal(movementMultiplier(b, sample, 0), 0.65);
  assert.equal(movementMultiplier(b, sample, 3), 0.65 * 0.85);
  assert.equal(movementMultiplier(b, { ...sample, position: { x: 4, y: 35 } }, 0), 1);
  flight(b, "replace", "adhesive_pod", "player", 7199);
  b = stepBattle(b);
  assert.equal(Object.keys(b.slowZones).length, 1);
  assert.equal(b.slowZones.player?.expiresAt, 241);
  while (b.world.tick < 241) b = stepBattle(b);
  assert.equal(movementMultiplier(b, sample, 0), 1);
  b = stepBattle(b);
  assert.deepEqual(b.slowZones, {});
});
