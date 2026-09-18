import assert from "node:assert/strict";
import test from "node:test";
import { assertObjectLocationsUnique } from "../../src/domain/objects.ts";
import { createBattle, stepBattle, type BattleState } from "../../src/simulation/physical-battle.ts";

function advanceUntilDeliveryReservation(seed: number): {
  state: BattleState;
  reservation: BattleState["reservations"][string];
} {
  let state = createBattle({ matchId: `r3-delivery-reselection-${seed}`, seed });
  for (let index = 0; index < 360; index += 1) {
    state = stepBattle(state);
    const reservation = Object.values(state.reservations).find((candidate) => candidate.kind === "delivery");
    if (reservation) return { state, reservation };
  }
  throw new Error("delivery reservation was not created during the fixture window");
}

test("R3 carrier AI reselects another ready turret after its reservation target is disabled", () => {
  const fixture = advanceUntilDeliveryReservation(11);
  const state = fixture.state;
  const reservation = fixture.reservation;
  const owner = state.actors[reservation.ownerActorId];
  assert.ok(owner);
  assert.equal(reservation.targetTurretId, "T1");
  const disabled = state.artillery.turrets[`${owner.team}:T1`];
  assert.ok(disabled);
  disabled.disabledUntilTick = state.tick + 100;

  const next = stepBattle(state);
  const replacement = Object.values(next.reservations).find((candidate) => candidate.objectIds.includes(reservation.objectIds[0]!));

  assert.ok(replacement);
  assert.equal(replacement.targetTurretId, "T2");
  assert.equal(next.objects[reservation.objectIds[0]!]?.location.kind, "reserved-carried");
  assertObjectLocationsUnique(next);
});

test("R3 carrier AI keeps cargo carried when every delivery turret is unavailable", () => {
  const fixture = advanceUntilDeliveryReservation(11);
  const state = fixture.state;
  const reservation = fixture.reservation;
  const owner = state.actors[reservation.ownerActorId];
  assert.ok(owner);
  for (const turret of Object.values(state.artillery.turrets).filter((candidate) => candidate.team === owner.team)) {
    turret.disabledUntilTick = state.tick + 100;
  }

  const next = stepBattle(state);
  const replacement = Object.values(next.reservations).find((candidate) => candidate.objectIds.includes(reservation.objectIds[0]!));

  assert.equal(replacement, undefined);
  assert.equal(next.objects[reservation.objectIds[0]!]?.location.kind, "carried");
  assert.equal(next.actors[owner.id]?.cargoIds.includes(reservation.objectIds[0]!), true);
  assert.equal(next.crew.assignments[owner.id]?.targetTurretId, undefined);
  assertObjectLocationsUnique(next);
});
