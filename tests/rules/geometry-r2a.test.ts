import assert from "node:assert/strict";
import test from "node:test";
import { createBattle } from "../../src/simulation/physical-battle.ts";
import { getHandoffPosition, getTurretOperatorPosition } from "../../src/artillery/positions.ts";
import { GATE_IDS, type CastleLayout, type GateId, type Point } from "../../src/domain/types.ts";
import {
  ACTION_RANGE_SUBUNITS,
  canOccupyFixed,
  EQUIPMENT_BODY_SIZE_SUBUNITS,
  equipmentRectForCell,
  equipmentRectangles,
  hasFloorLineOfSight,
  walkableApproachCells,
  walkableApproachSubpoints,
} from "../../src/actors/geometry.ts";
import type { BattleState, FixedPoint } from "../../src/simulation/physical-battle.ts";

interface GeometryOptions {
  widthCells: number;
  heightCells: number;
  floorCells: Point[];
  gateCells?: Partial<Record<GateId, Point[]>>;
  openGates?: GateId[];
  turretCells?: Point[];
  supplyCells?: Point[];
}

function equipmentDefinition(id: string, cell: Point): CastleLayout["turrets"][number] {
  return {
    id,
    label: id,
    roomId: "room",
    operatorActorId: null,
    queueCapacity: 2,
    stagingFloorSlots: 2,
    cell: { ...cell },
  };
}

function geometryState(options: GeometryOptions): BattleState {
  const state = createBattle({ matchId: "geometry-unit", seed: 1 });
  const base = state.layout.home;
  const gateCells = Object.fromEntries(GATE_IDS.map((gateId) => [
    gateId,
    [...(options.gateCells?.[gateId] ?? [])].map((cell) => ({ ...cell })),
  ])) as CastleLayout["gateCells"];
  const openGates = new Set(options.openGates ?? []);
  for (const gateId of GATE_IDS) state.castles.player.gates[gateId].open = openGates.has(gateId);
  state.layout = {
    ...state.layout,
    home: {
      ...base,
      widthCells: options.widthCells,
      heightCells: options.heightCells,
      rooms: [],
      links: [],
      floorCells: options.floorCells.map((cell) => ({ ...cell })),
      gateCells,
      turrets: (options.turretCells ?? []).map((cell, index) => equipmentDefinition(`T${index + 1}`, cell)),
      supplyPorts: (options.supplyCells ?? []).map((cell, index) => ({ id: `S${index + 1}`, roomId: "room", cell: { ...cell } })),
    },
  };
  return state;
}

function cellCenter(cell: Point): FixedPoint {
  return { x: cell.x * 1000 + 500, y: cell.y * 1000 + 500 };
}

test("exact circle-vs-cell AABB distance rejects a diagonal corner that radial samples miss", () => {
  const state = geometryState({
    widthCells: 2,
    heightCells: 2,
    floorCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
  });

  // The (1,1) corner is sqrt(240^2 + 140^2) subunits away. A 16-sample
  // circumference check misses this between-sample corner; exact AABB
  // distance must reject it.
  assert.equal(canOccupyFixed(state, "player", { x: 760, y: 860 }), false);
  assert.equal(canOccupyFixed(state, "player", { x: 700, y: 700 }), true);
});

test("closed gate cells block a circle and live gate state reopens them without rebuilding layout cache", () => {
  const state = geometryState({
    widthCells: 3,
    heightCells: 1,
    floorCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    gateCells: { G1: [{ x: 1, y: 0 }] },
  });
  const gateCenter = cellCenter({ x: 1, y: 0 });
  assert.equal(canOccupyFixed(state, "player", gateCenter), false);
  state.castles.player.gates.G1.open = true;
  assert.equal(canOccupyFixed(state, "player", gateCenter), true);
});

test("turret and supply-port cells are solid footprints while 0.8-range approach subpoints remain available", () => {
  const state = geometryState({
    widthCells: 4,
    heightCells: 3,
    floorCells: Array.from({ length: 12 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4) })),
    turretCells: [{ x: 1, y: 1 }],
    supplyCells: [{ x: 2, y: 1 }],
  });
  const target = cellCenter({ x: 1, y: 1 });
  assert.equal(EQUIPMENT_BODY_SIZE_SUBUNITS, 600);
  assert.deepEqual(equipmentRectForCell({ x: 1, y: 1 }), { x0: 1200, y0: 1200, x1: 1800, y1: 1800 });
  assert.equal(equipmentRectangles(state, "player").length, 2);
  assert.equal(canOccupyFixed(state, "player", target), false);
  // The equipment cell remains floor. Only its centered body is solid, so a
  // diagonal subpoint near the cell corner is still physically walkable.
  assert.equal(canOccupyFixed(state, "player", { x: 1001, y: 1001 }), true);

  const approach = walkableApproachSubpoints(state, "player", target);
  assert.ok(approach.length > 0);
  assert.ok(approach.every((point) => canOccupyFixed(state, "player", point)));
  assert.ok(approach.every((point) => {
    const dx = point.x - target.x;
    const dy = point.y - target.y;
    return dx * dx + dy * dy <= ACTION_RANGE_SUBUNITS * ACTION_RANGE_SUBUNITS;
  }));
  assert.ok(approach.some((point) => point.x < target.x && point.y === target.y));
  assert.ok(approach.some((point) => point.x !== target.x && point.y !== target.y));
  assert.ok(walkableApproachCells(state, "player", target).some((cell) => cell.x === 0 && cell.y === 1));
});

test("floor LOS blocks walls and closed gates but allows an equipment target center", () => {
  const wall = geometryState({
    widthCells: 3,
    heightCells: 1,
    floorCells: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
  });
  assert.equal(hasFloorLineOfSight(wall, "player", cellCenter({ x: 0, y: 0 }), cellCenter({ x: 2, y: 0 })), false);

  const gate = geometryState({
    widthCells: 3,
    heightCells: 1,
    floorCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    gateCells: { G1: [{ x: 1, y: 0 }] },
  });
  const from = cellCenter({ x: 0, y: 0 });
  const to = cellCenter({ x: 2, y: 0 });
  assert.equal(hasFloorLineOfSight(gate, "player", from, to), false);
  gate.castles.player.gates.G1.open = true;
  assert.equal(hasFloorLineOfSight(gate, "player", from, to), true);

  const equipment = geometryState({
    widthCells: 2,
    heightCells: 1,
    floorCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    turretCells: [{ x: 1, y: 0 }],
  });
  assert.equal(hasFloorLineOfSight(equipment, "player", cellCenter({ x: 0, y: 0 }), cellCenter({ x: 1, y: 0 })), true);
});

test("a one-cell corridor keeps its center walkable but rejects a radius-280 wall graze", () => {
  const state = geometryState({
    widthCells: 3,
    heightCells: 3,
    floorCells: [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  });
  assert.equal(canOccupyFixed(state, "player", cellCenter({ x: 1, y: 1 })), true);
  assert.equal(canOccupyFixed(state, "player", { x: 1500, y: 1220 }), false);
  assert.equal(canOccupyFixed(state, "player", { x: 1500, y: 1281 }), true);
});

test("the mirrored enemy castle uses the same collision and LOS rules", () => {
  const state = createBattle({ matchId: "geometry-mirror", seed: 5 });
  const homeTurret = state.layout.home.turrets.find((turret) => turret.id === "T1");
  const enemyTurret = state.layout.enemy.turrets.find((turret) => turret.id === "T1");
  assert.ok(homeTurret && enemyTurret);
  assert.equal(enemyTurret!.cell.x, 125 - homeTurret!.cell.x);
  assert.equal(enemyTurret!.cell.y, homeTurret!.cell.y);

  const homeCenter = cellCenter(homeTurret!.cell);
  const enemyCenter = cellCenter(enemyTurret!.cell);
  assert.equal(canOccupyFixed(state, "player", homeCenter), false);
  assert.equal(canOccupyFixed(state, "enemy", enemyCenter), false);
  assert.ok(walkableApproachSubpoints(state, "player", homeCenter).length > 0);
  assert.ok(walkableApproachSubpoints(state, "enemy", enemyCenter).length > 0);
  assert.equal(hasFloorLineOfSight(state, "player", homeCenter, homeCenter), true);
  assert.equal(hasFloorLineOfSight(state, "enemy", enemyCenter, enemyCenter), true);
});

test("geometry does not decide cross-team interaction ownership", () => {
  const state = createBattle({ matchId: "geometry-scope", seed: 6 });
  const actor = state.actors.P1;
  assert.equal(actor.location.castleTeam, "player");
  // Callers must compare actor.location.castleTeam and case.currentTeam before
  // using geometry; this module intentionally has no case ownership input.
  assert.equal(canOccupyFixed(state, "player", state.fixedActors.P1.position), true);
});

test("all eight turrets have fixed walkable LOS-valid operator and handoff points", () => {
  const state = createBattle({ matchId: "geometry-turret-positions", seed: 7 });
  const turrets = Object.values(state.artillery.turrets).sort((left, right) => `${left.team}:${left.id}`.localeCompare(`${right.team}:${right.id}`));
  assert.equal(turrets.length, 8);

  const distanceSquared = (left: FixedPoint, right: FixedPoint): number => {
    const dx = left.x - right.x;
    const dy = left.y - right.y;
    return dx * dx + dy * dy;
  };
  for (const turret of turrets) {
    const operator = getTurretOperatorPosition(turret);
    const slot0 = getHandoffPosition(turret, 0);
    const slot1 = getHandoffPosition(turret, 1);
    const points = [operator, slot0, slot1];
    for (const point of points) {
      assert.equal(canOccupyFixed(state, turret.team, point), true, `${turret.team}:${turret.id} point is walkable`);
      assert.equal(hasFloorLineOfSight(state, turret.team, point, turret.position), true, `${turret.team}:${turret.id} point sees turret`);
    }
    assert.equal(distanceSquared(operator, turret.position), 650 * 650);
    assert.equal(distanceSquared(operator, slot0), 350 * 350);
    assert.equal(distanceSquared(operator, slot1), 350 * 350);
    assert.equal(slot0.x, operator.x);
    assert.equal(slot1.x, operator.x);
    assert.equal(slot0.y, operator.y - 350);
    assert.equal(slot1.y, operator.y + 350);
  }
});
