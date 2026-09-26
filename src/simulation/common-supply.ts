import { CASE_TYPES, SUPPLY_BAG, caseDefinition, type CaseType } from "../content/cases.ts";
import {
  FLOOR_CASE_LIMIT_PER_ROOM,
  SUPPLY_FIRST_DELAY_TICKS,
  SUPPLY_GROUP_LIMIT_PER_SOURCE_TEAM,
  SUPPLY_PERIOD_TICKS,
} from "../logistics/logistics.ts";
import {
  advanceSupplySchedule,
  createSupplySchedule,
  currentSupplyType,
  previewSupplyTypes,
} from "../logistics/supply-schedule.ts";
import { roomContainsPoint } from "../domain/layout.ts";
import type {
  BattleState,
  CommonSupplyPort,
  CommonSupplyState,
} from "../domain/battle.ts";
import type {
  ObjectTransitionInput,
  Point,
  RejectedInput,
  StepReport,
  TeamId,
  WorldInput,
  WorldState,
} from "../domain/types.ts";

const TEAMS = ["player", "enemy"] as const satisfies readonly TeamId[];
const RETRY_TICKS = 30;

export interface CommonSupplySpawnPlan {
  team: TeamId;
  portKey: string;
  objectId: string;
  groupId: string;
  expectedCycle: number;
  expectedIndex: number;
  input: ObjectTransitionInput;
}

function portKey(team: TeamId, id: string): string {
  return `${team}:${id}`;
}

function layoutForTeam(world: WorldState, team: TeamId): typeof world.layout.home {
  return team === "player" ? world.layout.home : world.layout.enemy;
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function roomKey(team: TeamId, roomId: string): string {
  return `${team}:${roomId}`;
}

function commonSupplyReady(battle: BattleState, team: TeamId): boolean {
  if (battle.world.phase !== "running") return false;
  const stop = battle.supplyStops[team];
  return battle.world.tick >= stop.disruptedUntil &&
    (stop.equipmentDisabledUntil === null || battle.world.tick > stop.equipmentDisabledUntil);
}

function floorCaseCount(world: WorldState, team: TeamId, roomId: string): number {
  return Object.values(world.objects).filter((object) =>
    object.location.kind === "floor" && object.location.area !== "plaza" && object.location.team === team && object.location.roomId === roomId,
  ).length;
}

function activeGroupCount(world: WorldState, team: TeamId): number {
  const groups = new Set<string>();
  for (const object of Object.values(world.objects)) {
    if (object.sourceTeam !== team || !object.originGroupId || object.location.kind === "consumed") continue;
    groups.add(object.originGroupId);
  }
  return groups.size;
}

function spawnPosition(
  world: WorldState,
  team: TeamId,
  roomId: string,
  preferred: Point,
  reserved: ReadonlySet<string>,
): Point | undefined {
  const layout = layoutForTeam(world, team);
  const room = layout.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return undefined;
  const equipment = new Set([
    ...layout.turrets.map((turret) => pointKey(turret.cell)),
    ...layout.supplyPorts.map((port) => pointKey(port.cell)),
  ]);
  const occupied = new Set(
    Object.values(world.objects)
      .filter((object) => object.location.kind === "floor" && object.location.area !== "plaza" && object.location.team === team && object.location.roomId === roomId)
      .map((object) => object.location.kind === "floor" ? pointKey(object.location.position) : ""),
  );
  return layout.floorCells
    .filter((cell) => roomContainsPoint(room, cell))
    .filter((cell) => !equipment.has(pointKey(cell)) && !occupied.has(pointKey(cell)) && !reserved.has(pointKey(cell)))
    .sort((left, right) => {
      const leftDistance = (left.x - preferred.x) ** 2 + (left.y - preferred.y) ** 2;
      const rightDistance = (right.x - preferred.x) ** 2 + (right.y - preferred.y) ** 2;
      return leftDistance - rightDistance || left.y - right.y || left.x - right.x;
    })[0];
}

function sortedPorts(battle: BattleState): CommonSupplyPort[] {
  return Object.values(battle.supply.ports).sort((left, right) =>
    left.team.localeCompare(right.team) || left.id.localeCompare(right.id),
  );
}

function nextObjectId(port: CommonSupplyPort): string {
  return `common-case-${port.team}-${port.id}-g${String(port.groupSequence + 1).padStart(2, "0")}`;
}

function nextGroupId(port: CommonSupplyPort): string {
  return `common-group-${port.team}-${port.id}-g${String(port.groupSequence + 1).padStart(2, "0")}`;
}

/** Create the common producer state without creating a floor object. */
export interface CommonSupplyOptions {
  /** Only the player's loadout is configurable through the public battle API. */
  playerAllocation?: readonly CaseType[];
}

export function createCommonSupplyState(world: WorldState, options: CommonSupplyOptions = {}): CommonSupplyState {
  const allocation = [...(options.playerAllocation ?? SUPPLY_BAG)];
  const ports: Record<string, CommonSupplyPort> = {};
  for (const team of TEAMS) {
    const layout = layoutForTeam(world, team);
    layout.supplyPorts.forEach((port, index) => {
      ports[portKey(team, port.id)] = {
        id: port.id,
        team,
        roomId: port.roomId,
        nextSpawnTick: SUPPLY_FIRST_DELAY_TICKS[index] ?? SUPPLY_FIRST_DELAY_TICKS[0],
        groupSequence: 0,
      };
    });
  }
  const schedules = {
    player: createSupplySchedule({ seed: world.seed, team: "player", allocation }),
    enemy: createSupplySchedule({ seed: world.seed, team: "enemy", allocation: SUPPLY_BAG }),
  };
  return {
    ports,
    schedules,
    allocation: [...schedules.player.allocation],
  };
}

/** Return the two upcoming player entries without exposing the enemy schedule. */
export function getPlayerSupplyPreview(battle: BattleState): readonly CaseType[] {
  return previewSupplyTypes(battle.supply.schedules.player);
}

/**
 * Prepare all common-world supply transitions for this fixed update.
 *
 * The returned inputs are submitted together with artillery damage to one
 * `stepWorld` call. The schedule is intentionally not advanced here: a
 * rejected common transition must not consume a case type.
 */
export function prepareCommonSupplySpawns(battle: BattleState): CommonSupplySpawnPlan[] {
  const plans: CommonSupplySpawnPlan[] = [];
  const planningSchedules = { ...battle.supply.schedules };
  const reservedCells = new Set<string>();
  const plannedFloorCounts = new Map<string, number>();
  const plannedGroups = new Map<TeamId, number>();

  for (const port of sortedPorts(battle)) {
    const schedule = planningSchedules[port.team];
    if (battle.world.tick < port.nextSpawnTick || !commonSupplyReady(battle, port.team)) continue;

    const floorKey = roomKey(port.team, port.roomId);
    const floorCount = floorCaseCount(battle.world, port.team, port.roomId) + (plannedFloorCounts.get(floorKey) ?? 0);
    if (floorCount >= FLOOR_CASE_LIMIT_PER_ROOM) {
      port.nextSpawnTick = battle.world.tick + RETRY_TICKS;
      continue;
    }
    const groupCount = activeGroupCount(battle.world, port.team) + (plannedGroups.get(port.team) ?? 0);
    if (groupCount >= SUPPLY_GROUP_LIMIT_PER_SOURCE_TEAM) continue;

    const type = currentSupplyType(schedule);
    if (!CASE_TYPES.includes(type) || !caseDefinition(type)) continue;
    const layoutPort = layoutForTeam(battle.world, port.team).supplyPorts.find((candidate) => candidate.id === port.id);
    if (!layoutPort) continue;
    const position = spawnPosition(battle.world, port.team, port.roomId, layoutPort.cell, reservedCells);
    if (!position) {
      port.nextSpawnTick = battle.world.tick + RETRY_TICKS;
      continue;
    }

    const definition = caseDefinition(type);
    if (!definition) continue;
    const objectId = nextObjectId(port);
    const groupId = nextGroupId(port);
    plans.push({
      team: port.team,
      portKey: portKey(port.team, port.id),
      objectId,
      groupId,
      expectedCycle: schedule.cycle,
      expectedIndex: schedule.index,
      input: {
        kind: "spawn_supply",
        objectId,
        team: port.team,
        portId: port.id,
        weaponId: type,
        weight: definition.weight,
        originGroupId: groupId,
        roomId: port.roomId,
        position,
        matchId: battle.world.matchId,
      },
    });
    reservedCells.add(pointKey(position));
    plannedFloorCounts.set(floorKey, (plannedFloorCounts.get(floorKey) ?? 0) + 1);
    plannedGroups.set(port.team, (plannedGroups.get(port.team) ?? 0) + 1);
    planningSchedules[port.team] = advanceSupplySchedule(schedule);
  }
  return plans;
}

function rejectedIndexes(report: StepReport): Set<number> {
  return new Set(report.rejected.map((rejection: RejectedInput) => rejection.inputIndex));
}

/** Commit only transitions accepted by the common world. */
export function commitCommonSupplySpawns(
  battle: BattleState,
  plans: readonly CommonSupplySpawnPlan[],
  inputOffset: number,
  report: StepReport,
): void {
  const rejected = rejectedIndexes(report);
  const processedTick = report.processedTick;
  if (processedTick === null) return;

  for (const [index, plan] of plans.entries()) {
    if (rejected.has(inputOffset + index)) continue;
    const object = battle.world.objects[plan.objectId];
    if (!object || object.location.kind !== "floor") continue;
    const schedule = battle.supply.schedules[plan.team];
    if (schedule.cycle !== plan.expectedCycle || schedule.index !== plan.expectedIndex) {
      throw new Error(`common supply schedule cursor drift for ${plan.team}`);
    }
    const port = battle.supply.ports[plan.portKey];
    if (!port) throw new Error(`common supply port ${plan.portKey} is missing`);
    port.nextSpawnTick = processedTick + SUPPLY_PERIOD_TICKS;
    port.groupSequence += 1;
    battle.supply.schedules[plan.team] = advanceSupplySchedule(schedule);
  }
}

export function commonSupplyInputs(plans: readonly CommonSupplySpawnPlan[]): WorldInput[] {
  return plans.map((plan) => plan.input);
}
