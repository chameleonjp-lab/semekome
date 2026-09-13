import assert from "node:assert/strict";
import test from "node:test";
import { cellCenter, floorCell } from "../../src/actors/movement.ts";
import { PART_IDS } from "../../src/domain/types.ts";
import { createWorld, stepWorld } from "../../src/simulation/world.ts";
import { bridgeActorFirstContact, bridgeCoreFirstContact, preparePlazaEntry } from "../../src/simulation/r2b-bridge.ts";
import { createBattle, stepBattle as stepPhysicalBattle } from "../../src/simulation/physical-battle.ts";
import type { BattleState } from "../../src/simulation/physical-battle.ts";

function coreState(matchId: string): { state: BattleState; from: { x: number; y: number }; to: { x: number; y: number } } {
  const state = createBattle({ matchId, seed: 71 });
  const targetTeam = "enemy" as const;
  const layout = state.layout.enemy;
  const core = layout.rooms.find((room) => room.id === "core");
  assert.ok(core);
  for (const gate of layout.coreRouteGates) state.castles[targetTeam].gates[gate].open = true;
  state.castles[targetTeam].openGateIds = [...layout.coreRouteGates];
  const to = { x: cellCenter(core.rect.x0 + 4), y: cellCenter(core.rect.y0 + 5) };
  const from = { x: to.x - 50, y: to.y };
  const actor = state.actors.P1;
  actor.location = {
    area: "castle",
    castleTeam: targetTeam,
    roomId: "core",
    pathRooms: [...layout.coreRouteRooms],
    pathGates: [...layout.coreRouteGates],
  };
  actor.currentRoomId = "core";
  actor.position = { x: floorCell(from.x), y: floorCell(from.y) };
  state.fixedActors.P1.position = { ...from };
  state.fixedActors.P1.remainder = { x: 0, y: 0 };
  return { state, from, to };
}

function actorContactState(matchId: string): { state: BattleState; from: { x: number; y: number }; target: { x: number; y: number } } {
  const state = createBattle({ matchId, seed: 79 });
  const from = { x: 49_500, y: 57_500 };
  const target = { x: 50_000, y: 57_500 };
  for (const [actorId, point] of [["P1", from], ["E29", target]] as const) {
    const actor = state.actors[actorId];
    actor.location = { area: "castle", castleTeam: "enemy", roomId: "command", pathRooms: ["command"], pathGates: [] };
    actor.currentRoomId = "command";
    actor.position = { x: floorCell(point.x), y: floorCell(point.y) };
    state.fixedActors[actorId].position = { ...point };
    state.fixedActors[actorId].remainder = { x: 0, y: 0 };
  }
  return { state, from, target };
}

test("R2b core bridge accepts only a current physical dash first-contact envelope", () => {
  const { state, from, to } = coreState("r2b-core");
  const base = {
    matchId: state.matchId,
    tick: state.tick,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    targetTeam: "enemy" as const,
    attackType: "dash" as const,
    firstContact: "core" as const,
    from,
    to,
  };

  const accepted = bridgeCoreFirstContact(state, base);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  const ended = stepWorld(state, accepted.value);
  assert.equal(ended.outcome, "player_win");
  assert.equal(ended.tick, 1, "the bridge input is consumed by one world tick");

  const stalePosition = bridgeCoreFirstContact(state, { ...base, from: { x: from.x + 50, y: from.y } });
  assert.equal(stalePosition.ok, false);
  assert.equal(stalePosition.reason, "stale_snapshot");

  const wallContact = bridgeCoreFirstContact(state, { ...base, firstContact: "wall" });
  assert.equal(wallContact.ok, false);
  assert.equal(wallContact.reason, "invalid_contact");

  const normalContact = bridgeCoreFirstContact(state, { ...base, attackType: "normal_contact" });
  assert.equal(normalContact.ok, false);
  assert.equal(normalContact.reason, "invalid_contact");
});

test("R2b core bridge rejects an incomplete seven-gate route", () => {
  const { state, from, to } = coreState("r2b-closed-route");
  state.castles.enemy.gates.G7.open = false;
  state.castles.enemy.openGateIds = ["G1", "G2", "G3", "G4", "G5", "G6"];
  const result = bridgeCoreFirstContact(state, {
    matchId: state.matchId,
    tick: state.tick,
    actorId: "P1",
    generation: state.actors.P1.generation,
    targetTeam: "enemy",
    attackType: "dash",
    firstContact: "core",
    from,
    to,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "closed_route");
});

test("R2b core evidence is consumed by the physical coordinator in one shared tick", () => {
  const { state, from, to } = coreState("r2b-physical-core");
  for (const partId of PART_IDS) {
    state.castles.enemy.exterior[partId].destroyed = true;
    state.castles.enemy.exterior[partId].health = 0;
  }
  state.castles.enemy.destroyedPartIds = [...PART_IDS];

  const next = stepPhysicalBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    bridge: {
      kind: "core_contact",
      evidence: {
        matchId: state.matchId,
        tick: state.tick,
        actorId: "P1",
        generation: state.actors.P1.generation,
        targetTeam: "enemy",
        attackType: "dash",
        firstContact: "core",
        from,
        to,
      },
    },
  });

  assert.equal(next.tick, 1, "physical and common rules share one clock advance");
  assert.equal(next.outcome, "player_win");
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:core_contact"), true);
  assert.equal(next.lastStep.events.filter((event) => event.type === "outcome").length, 1);
});

test("R2b evidence cannot bypass a rejected physical intent envelope", () => {
  const { state, from, to } = coreState("r2b-physical-binding");
  const next = stepPhysicalBattle(state, {
    matchId: "different-match",
    actorId: "P1",
    generation: state.actors.P1.generation,
    bridge: {
      kind: "core_contact",
      evidence: {
        matchId: state.matchId,
        tick: state.tick,
        actorId: "P1",
        generation: state.actors.P1.generation,
        targetTeam: "enemy",
        attackType: "dash",
        firstContact: "core",
        from,
        to,
      },
    },
  });

  assert.equal(next.outcome, "ongoing");
  assert.equal(next.lastStep.rejected.some((rejection) => rejection.reason === "wrong_match"), true);
  assert.equal(next.tick, 1);
});

test("R2b actor contact applies one common-world damage and physical knockback", () => {
  const { state, from, target } = actorContactState("r2b-actor-contact");
  const evidence = {
    matchId: state.matchId,
    tick: state.tick,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    targetActorId: "E29" as const,
    targetGeneration: state.actors.E29.generation,
    attackType: "dash" as const,
    firstContact: "actor" as const,
    from,
    to: target,
    targetPosition: target,
  };

  const prepared = bridgeActorFirstContact(state, evidence);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.value.amount, 1);
  assert.equal(prepared.value.actorId, "E29");

  const next = stepPhysicalBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    bridge: { kind: "actor_contact", evidence },
  });
  assert.equal(next.tick, 1);
  assert.equal(next.actors.E29.health, 3);
  assert.equal(next.actors.E29.damageImmuneUntilTick, 36);
  assert.deepEqual(next.fixedActors.E29.position, { x: 50_600, y: 57_500 });
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:actor_contact"), true);
  assert.deepEqual(next.lastStep.events.filter((event) => event.type === "actor_damaged"), [
    { type: "actor_damaged", actorId: "E29", amount: 1 },
  ]);
});

test("R2b actor contact drops the target's selected cargo and blocks repeat damage", () => {
  const { state, from, target } = actorContactState("r2b-actor-drop");
  const caseId = "case-contact-drop";
  state.actors.E29.cargoIds = [caseId];
  state.cargoSlots.E29 = [caseId, null];
  state.battleCases[caseId] = {
    id: caseId,
    type: "standard_slug",
    sourceTeam: "enemy",
    currentTeam: "enemy",
    weight: 1,
    location: "carried",
    currentPosition: { ...target },
    ownerActorId: "E29",
    ownerGeneration: state.actors.E29.generation,
    originGroupId: "group-contact-drop",
    sourcePortId: "enemy-port-a",
    createdTick: state.tick,
    roomId: "command",
  };
  state.objects[caseId] = {
    id: caseId,
    sourceTeam: "enemy",
    weight: 1,
    originGroupId: "group-contact-drop",
    location: { kind: "carried", actorId: "E29", slot: 0 },
  };
  const evidence = {
    matchId: state.matchId,
    tick: state.tick,
    actorId: "P1" as const,
    generation: state.actors.P1.generation,
    targetActorId: "E29" as const,
    targetGeneration: state.actors.E29.generation,
    attackType: "dash" as const,
    firstContact: "actor" as const,
    from,
    to: target,
    targetPosition: target,
    targetCargoId: caseId,
  };

  const next = stepPhysicalBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    bridge: { kind: "actor_contact", evidence },
  });
  assert.equal(next.actors.E29.health, 3);
  assert.deepEqual(next.actors.E29.cargoIds, []);
  assert.deepEqual(next.cargoSlots.E29, [null, null]);
  assert.equal(next.battleCases[caseId].location, "floor");
  assert.deepEqual(next.battleCases[caseId].currentPosition, target);
  assert.equal(next.lastStep.events.some((event) => event.type === "object_moved" && event.objectId === caseId), true);

  const repeat = stepWorld(next, {
    kind: "damage_actor",
    matchId: next.matchId,
    actorId: "E29",
    generation: next.actors.E29.generation,
    amount: 1,
  });
  assert.equal(repeat.actors.E29.health, 3);
  assert.equal(repeat.lastStep.rejected[0]?.reason, "invulnerable_actor");
});

test("R2b plaza evidence enters the castle through the physical coordinator", () => {
  const state = createBattle({ matchId: "r2b-physical-plaza", seed: 73 });
  state.actors.P1.location = { area: "plaza", pathRooms: [], pathGates: [] };
  state.actors.P1.currentRoomId = "plaza";
  for (const guardId of ["E25", "E26", "E27"] as const) {
    const guard = state.actors[guardId];
    guard.location = { area: "plaza", pathRooms: [], pathGates: [] };
    guard.currentRoomId = "plaza";
    guard.alive = false;
    guard.health = 0;
    guard.respawnAtTick = 9999;
  }

  const next = stepPhysicalBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    bridge: {
      kind: "plaza_entry",
      evidence: {
        matchId: state.matchId,
        tick: state.tick,
        actorId: "P1",
        generation: state.actors.P1.generation,
        targetTeam: "enemy",
        guardGenerations: { E25: 0, E26: 0, E27: 0 },
      },
    },
  });

  assert.equal(next.tick, 1, "plaza clearance and entry do not add a second tick");
  assert.equal(next.actors.P1.location.area, "castle");
  assert.equal(next.actors.P1.location.castleTeam, "enemy");
  assert.equal(next.actors.P1.currentRoomId, "entry");
  assert.equal(next.lastStep.acceptedInputKinds.includes("bridge:plaza_entry"), true);
  assert.equal(next.plaza.enemyCrossings["P1:0"]?.allowed, true);
});

test("R2b plaza entry binds the crossing to live guard generations and does not advance the clock", () => {
  let world = createWorld({ matchId: "r2b-plaza", seed: 72 });
  world.actors.P1.location = { area: "plaza", pathRooms: [], pathGates: [] };
  world.actors.P1.currentRoomId = "plaza";
  world.actors.E25.location = { area: "plaza", pathRooms: [], pathGates: [] };
  world.actors.E25.currentRoomId = "plaza";

  const missingGuardSnapshot = preparePlazaEntry(world, {
    matchId: world.matchId,
    tick: world.tick,
    actorId: "P1",
    generation: world.actors.P1.generation,
    targetTeam: "enemy",
    guardGenerations: {},
  });
  assert.equal(missingGuardSnapshot.ok, false);
  assert.equal(missingGuardSnapshot.reason, "stale_generation");

  const blocked = preparePlazaEntry(world, {
    matchId: world.matchId,
    tick: world.tick,
    actorId: "P1",
    generation: world.actors.P1.generation,
    targetTeam: "enemy",
    guardGenerations: { E25: world.actors.E25.generation },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "guards_remaining");

  world = stepWorld(world, {
    kind: "damage_actor",
    matchId: world.matchId,
    actorId: "E25",
    generation: world.actors.E25.generation,
    amount: 99,
  });
  const prepared = preparePlazaEntry(world, {
    matchId: world.matchId,
    tick: world.tick,
    actorId: "P1",
    generation: world.actors.P1.generation,
    targetTeam: "enemy",
    guardGenerations: { E25: 0 },
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.value.state.tick, world.tick);
  assert.equal(world.plaza.enemyCrossings["P1:0"], undefined, "preparing a bridge must not mutate its source");
  assert.equal(prepared.value.state.plaza.defeatedGuardGenerations.E25, 0);

  const entered = stepWorld(prepared.value.state, prepared.value.input);
  assert.equal(entered.actors.P1.location.area, "castle");
  assert.equal(entered.actors.P1.location.castleTeam, "enemy");
  assert.equal(entered.actors.P1.currentRoomId, "entry");

  const stalePermission = structuredClone(prepared.value.state);
  stalePermission.actors.E25.generation += 1;
  stalePermission.actors.E25.alive = true;
  stalePermission.actors.E25.location = { area: "castle", castleTeam: "enemy", roomId: "repair", pathRooms: ["repair"], pathGates: [] };
  stalePermission.actors.E25.currentRoomId = "repair";
  const reused = stepWorld(stalePermission, prepared.value.input);
  assert.equal(reused.actors.P1.location.area, "plaza");
  assert.equal(reused.lastStep.rejected[0]?.reason, "invalid_transition");
});
