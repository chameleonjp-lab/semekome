import assert from "node:assert/strict";
import test from "node:test";
import { cellCenter, floorCell } from "../../src/actors/movement.ts";
import { PART_IDS } from "../../src/domain/types.ts";
import { createWorld, stepWorld } from "../../src/simulation/world.ts";
import { bridgeCoreFirstContact, preparePlazaEntry } from "../../src/simulation/r2b-bridge.ts";
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
