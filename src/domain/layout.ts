import { GATE_IDS, PART_IDS, type CastleLayout, type CastleState, type GateId, type LayoutLink, type PartId, type Point, type RecoveryPad, type RoomDefinition, type TeamId, type WorldLayout } from "./types.ts";
import { DEFAULT_RULES } from "../content/rules.ts";
import { actorDefinitions, type ActorDefinition } from "../content/roster.ts";
import { DEFAULT_LAYOUT, roomDefinition } from "../content/layouts.ts";

export function createCastleState(team: TeamId, partHealth = DEFAULT_RULES.exteriorPartHealth): CastleState {
  const exterior = Object.fromEntries(PART_IDS.map((id) => [id, {
    id,
    maxHealth: partHealth,
    health: partHealth,
    destroyed: false,
  }])) as Record<PartId, CastleState["exterior"][PartId]>;
  const gates = Object.fromEntries(GATE_IDS.map((id) => [id, { id, open: false }])) as CastleState["gates"];
  return {
    team,
    exterior,
    gates,
    destroyedPartIds: [],
    openGateIds: [],
    core: { roomId: "core", hit: false },
  };
}

export function mirrorPointForLayout(point: Point, widthCells = DEFAULT_LAYOUT.widthCells): Point {
  return { x: widthCells - 1 - point.x, y: point.y };
}

export function roomContainsPoint(room: RoomDefinition, point: Point): boolean {
  return room.rect.x0 <= point.x && point.x < room.rect.x1 && room.rect.y0 <= point.y && point.y < room.rect.y1;
}

export function padById(layout: CastleLayout, padId: string): RecoveryPad | undefined {
  for (const room of layout.rooms) {
    const pad = room.recoveryPads.find((candidate) => candidate.id === padId);
    if (pad) return pad;
  }
  return undefined;
}

export function actorInitialPosition(layout: CastleLayout, definition: ActorDefinition): Point {
  const room = roomDefinition(layout, definition.initialRoomId);
  if (!room) throw new Error(`initial room ${definition.initialRoomId} for ${definition.id} is missing`);
  if (definition.initialPosition) {
    const cell = definition.initialPosition;
    if (!roomContainsPoint(room, cell) || !layout.floorCells.some((floor) => floor.x === cell.x && floor.y === cell.y)) {
      throw new Error(`initial position for ${definition.id} is outside its room floor`);
    }
    return { ...cell };
  }
  // Initial placement follows initialRoomId. A respawn pad is used at match
  // start only when the documented initial room is itself the respawn room.
  if (definition.initialRoomId === definition.respawnRoomId) {
    const pad = padById(layout, definition.respawnPadId);
    if (!pad || !pad.walkable) throw new Error(`respawn pad ${definition.respawnPadId} for ${definition.id} is missing or not walkable`);
    return { ...pad.cell };
  }
  const position = {
    x: Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2),
    y: Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2),
  };
  if (!layout.floorCells.some((floor) => floor.x === position.x && floor.y === position.y)) {
    throw new Error(`initial room center for ${definition.id} is not a floor cell`);
  }
  return position;
}

export function linkedRoom(layout: CastleLayout, from: string, to: string): LayoutLink | undefined {
  return layout.links.find((link) =>
    (link.a === from && link.b === to) || (link.a === to && link.b === from));
}

export function canTraverse(
  layout: CastleLayout,
  from: string,
  to: string,
  openGates: ReadonlySet<GateId> | readonly GateId[],
): boolean {
  const link = linkedRoom(layout, from, to);
  if (!link) return false;
  if (!link.gateId) return true;
  if (Array.isArray(openGates)) return openGates.includes(link.gateId);
  return (openGates as ReadonlySet<GateId>).has(link.gateId);
}

function roomIds(layout: CastleLayout): Set<string> {
  return new Set(layout.rooms.map((room) => room.id));
}

function graphNeighbors(layout: CastleLayout, roomId: string): Array<{ roomId: string; gateId?: GateId }> {
  const neighbors: Array<{ roomId: string; gateId?: GateId }> = [];
  for (const link of layout.links) {
    if (link.a === roomId) neighbors.push({ roomId: link.b, gateId: link.gateId });
    if (link.b === roomId) neighbors.push({ roomId: link.a, gateId: link.gateId });
  }
  return neighbors;
}

export interface LayoutValidationResult {
  valid: boolean;
  errors: string[];
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function adjacentCells(cell: Point): Point[] {
  return [
    { x: cell.x - 1, y: cell.y },
    { x: cell.x + 1, y: cell.y },
    { x: cell.x, y: cell.y - 1 },
    { x: cell.x, y: cell.y + 1 },
  ];
}

function openGateSet(openGates: ReadonlySet<GateId> | readonly GateId[]): ReadonlySet<GateId> {
  if (openGates instanceof Set) return openGates;
  return new Set(openGates as readonly GateId[]);
}

/**
 * Reachability over authored floor cells. Gate cells are removed while their
 * gate is closed; this prevents a room graph edge from becoming a physical
 * teleport and lets the layout contract prove each gate is a real blocker.
 */
export function canReachRoomOnFloor(
  layout: CastleLayout,
  fromRoom: string,
  targetRoom: string,
  openGates: ReadonlySet<GateId> | readonly GateId[],
): boolean {
  const floor = new Set(layout.floorCells.map(pointKey));
  const open = openGateSet(openGates);
  const blocked = new Set(
    GATE_IDS
      .filter((gateId) => !open.has(gateId))
      .flatMap((gateId) => (layout.gateCells[gateId] ?? []).map(pointKey)),
  );
  const startRoom = roomDefinition(layout, fromRoom);
  const target = roomDefinition(layout, targetRoom);
  if (!startRoom || !target) return false;
  const queue: Point[] = [];
  const visited = new Set<string>();
  for (const cell of layout.floorCells) {
    if (roomContainsPoint(startRoom, cell) && !blocked.has(pointKey(cell))) {
      const key = pointKey(cell);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(cell);
      }
    }
  }
  const targetKeys = new Set(
    layout.floorCells
      .filter((cell) => roomContainsPoint(target, cell) && !blocked.has(pointKey(cell)))
      .map(pointKey),
  );
  for (let index = 0; index < queue.length; index += 1) {
    const cell = queue[index];
    if (targetKeys.has(pointKey(cell))) return true;
    for (const next of adjacentCells(cell)) {
      const key = pointKey(next);
      if (floor.has(key) && !blocked.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push(next);
      }
    }
  }
  return false;
}

export function canReachCoreOnFloor(
  layout: CastleLayout,
  fromRoom: string,
  openGates: ReadonlySet<GateId> | readonly GateId[],
): boolean {
  return canReachRoomOnFloor(layout, fromRoom, "core", openGates);
}

function actorCastle(layout: WorldLayout, team: TeamId): CastleLayout {
  return team === "player" ? layout.home : layout.enemy;
}

function floorContains(layout: CastleLayout, point: Point): boolean {
  return layout.floorCells.some((cell) => cell.x === point.x && cell.y === point.y);
}

/**
 * Validates roster references against the authored castle geometry. This is
 * deliberately separate from the room graph check: a missing or misplaced
 * respawn pad must fail world creation rather than falling back to a room
 * center and silently changing the roster's ownership.
 */
export function validateActorDefinitionsForLayout(
  layout: WorldLayout,
  definitions: readonly ActorDefinition[] = actorDefinitions(),
): LayoutValidationResult {
  const errors: string[] = [];
  for (const team of ["player", "enemy"] as const) {
    const castle = actorCastle(layout, team);
    const teamDefinitions = definitions.filter((definition) => definition.team === team);
    const pads = castle.rooms.flatMap((room) => room.recoveryPads);
    const padIds = new Set<string>();
    const padOwners = new Set<string>();
    const padCells = new Set<string>();
    for (const pad of pads) {
      if (padIds.has(pad.id)) errors.push(`${team}: duplicate recovery pad id ${pad.id}`);
      padIds.add(pad.id);
      if (padOwners.has(pad.actorId)) errors.push(`${team}: duplicate recovery pad actor ${pad.actorId}`);
      padOwners.add(pad.actorId);
      const owner = teamDefinitions.find((definition) => definition.id === pad.actorId);
      if (!owner) errors.push(`${team}: recovery pad ${pad.id} references unknown actor ${pad.actorId}`);
      const cellKey = pointKey(pad.cell);
      if (padCells.has(cellKey)) errors.push(`${team}: duplicate recovery pad floor ${cellKey}`);
      padCells.add(cellKey);
      if (!pad.walkable || !floorContains(castle, pad.cell)) errors.push(`${team}: recovery pad ${pad.id} is not a valid floor cell`);
    }
    if (pads.length !== teamDefinitions.length) errors.push(`${team}: recovery pad count does not match actor count`);
    const referencedPadIds = new Set<string>();
    for (const definition of teamDefinitions) {
      const initialRoom = roomDefinition(castle, definition.initialRoomId);
      if (!initialRoom) {
        errors.push(`${team}: ${definition.id} initial room ${definition.initialRoomId} is missing`);
      } else {
        if (definition.initialRoomId === "core") errors.push(`${team}: ${definition.id} initial room cannot be core`);
        if (!canReachRoomOnFloor(castle, "central_corridor", definition.initialRoomId, [])) {
          errors.push(`${team}: ${definition.id} initial room is behind a closed gate`);
        }
        const initialPosition = definition.initialPosition ?? {
          x: Math.floor((initialRoom.rect.x0 + initialRoom.rect.x1 - 1) / 2),
          y: Math.floor((initialRoom.rect.y0 + initialRoom.rect.y1 - 1) / 2),
        };
        if (!roomContainsPoint(initialRoom, initialPosition) || !floorContains(castle, initialPosition)) {
          errors.push(`${team}: ${definition.id} initial position is not a valid floor cell`);
        }
      }
      const respawnRoom = roomDefinition(castle, definition.respawnRoomId);
      if (!respawnRoom) {
        errors.push(`${team}: ${definition.id} respawn room ${definition.respawnRoomId} is missing`);
      } else {
        if (definition.respawnRoomId === "core") errors.push(`${team}: ${definition.id} respawn room cannot be core`);
        if (!canReachRoomOnFloor(castle, "central_corridor", definition.respawnRoomId, [])) {
          errors.push(`${team}: ${definition.id} respawn room is behind a closed gate`);
        }
      }
      const pad = padById(castle, definition.respawnPadId);
      if (!pad) {
        errors.push(`${team}: ${definition.id} references missing respawn pad ${definition.respawnPadId}`);
        continue;
      }
      if (referencedPadIds.has(pad.id)) errors.push(`${team}: respawn pad ${pad.id} is referenced more than once`);
      referencedPadIds.add(pad.id);
      if (pad.actorId !== definition.id) errors.push(`${team}: ${definition.id} does not own respawn pad ${pad.id}`);
      if (pad.roomId !== definition.respawnRoomId) errors.push(`${team}: ${definition.id} respawn pad room does not match respawnRoomId`);
      if (!pad.walkable || !floorContains(castle, pad.cell)) errors.push(`${team}: ${definition.id} respawn pad is not a valid floor cell`);
    }
    for (const pad of pads) {
      if (!referencedPadIds.has(pad.id)) errors.push(`${team}: unreferenced recovery pad ${pad.id}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Checks design invariants used by R1. Geometry is a design grid, so this
 * validates pad occupancy and graph reachability; it does not claim collision
 * or playtest success for the proposed dimensions.
 */
export function validateCastleLayout(layout: CastleLayout): LayoutValidationResult {
  const errors: string[] = [];
  const ids = roomIds(layout);
  if (ids.size !== layout.rooms.length) errors.push("duplicate room id");
  const floor = new Set(layout.floorCells.map((cell) => `${cell.x},${cell.y}`));
  if (floor.size !== layout.floorCells.length) errors.push("duplicate floor cell");
  const pads = new Set<string>();
  for (const room of layout.rooms) {
    for (const pad of room.recoveryPads) {
      if (!pad.walkable) errors.push(`pad ${pad.id} is not walkable`);
      if (pad.roomId !== room.id) errors.push(`pad ${pad.id} room mismatch`);
      if (!roomContainsPoint(room, pad.cell)) errors.push(`pad ${pad.id} outside room`);
      if (!floor.has(`${pad.cell.x},${pad.cell.y}`)) errors.push(`pad ${pad.id} is not on a floor cell`);
      const key = `${pad.cell.x},${pad.cell.y}`;
      if (pads.has(key)) errors.push(`duplicate recovery floor ${key}`);
      pads.add(key);
    }
  }
  for (const turret of layout.turrets) {
    const room = roomDefinition(layout, turret.roomId);
    if (!room || !roomContainsPoint(room, turret.cell)) errors.push(`turret ${turret.id} cell is outside its room`);
    if (!floor.has(`${turret.cell.x},${turret.cell.y}`)) errors.push(`turret ${turret.id} is not on a floor cell`);
  }
  for (const port of layout.supplyPorts) {
    const room = roomDefinition(layout, port.roomId);
    if (!room || !roomContainsPoint(room, port.cell)) errors.push(`supply port ${port.id} cell is outside its room`);
    if (!floor.has(`${port.cell.x},${port.cell.y}`)) errors.push(`supply port ${port.id} is not on a floor cell`);
  }

  for (const gateId of GATE_IDS) {
    const gateCells = layout.gateCells[gateId] ?? [];
    if (gateCells.length === 0) errors.push(`gate ${gateId} has no physical cells`);
    for (const cell of gateCells) {
      if (!floor.has(pointKey(cell))) errors.push(`gate ${gateId} cell ${pointKey(cell)} is not floor`);
    }
  }

  // With all gates open, every initial/revival floor must reach the core floor
  // without inventing a teleport or using an off-grid pad.
  const coreRoom = layout.rooms.find((room) => room.kind === "core" || room.id === "core");
  if (!coreRoom) errors.push("core room is missing");
  else {
    for (const key of pads) {
      const [x, y] = key.split(",").map(Number);
      if (!canReachCoreOnFloor(layout, layout.rooms.find((room) => room.recoveryPads.some((pad) => pointKey(pad.cell) === key))?.id ?? "", GATE_IDS)) {
        errors.push(`recovery floor ${key} cannot reach core floor`);
      }
    }
  }
  for (const link of layout.links) {
    if (!ids.has(link.a) || !ids.has(link.b)) errors.push(`link references unknown room ${link.a}/${link.b}`);
    if (link.gateId && !GATE_IDS.includes(link.gateId)) errors.push(`link references unknown gate ${link.gateId}`);
  }
  if (layout.coreRouteGates.length !== GATE_IDS.length || layout.coreRouteGates.some((gate, index) => gate !== GATE_IDS[index])) {
    errors.push("core route must use G1 through G7 in order");
  }
  if (layout.coreRouteRooms.length !== GATE_IDS.length + 3) errors.push("core route room count is invalid");
  for (let i = 0; i + 1 < layout.coreRouteRooms.length; i += 1) {
    const link = linkedRoom(layout, layout.coreRouteRooms[i], layout.coreRouteRooms[i + 1]);
    if (!link) errors.push(`core route link missing ${layout.coreRouteRooms[i]}/${layout.coreRouteRooms[i + 1]}`);
    if (i >= 2 && i < 9 && link?.gateId !== layout.coreRouteGates[i - 2]) {
      errors.push(`core route gate mismatch at ${i}`);
    }
  }

  // Every route to core in the room graph must carry all seven gate IDs. This
  // catches a future shortcut added beside the canonical route.
  const core = layout.coreRouteRooms.at(-1) ?? "core";
  const starts = layout.rooms.map((room) => room.id).filter((room) => room !== core);
  for (const start of starts) {
    const routeIndex = layout.coreRouteRooms.indexOf(start);
    const requiredGates = routeIndex >= 2
      ? layout.coreRouteGates.slice(routeIndex - 2)
      : layout.coreRouteGates;
    const queue: Array<{ roomId: string; gates: GateId[]; visited: Set<string> }> = [{ roomId: start, gates: [], visited: new Set([start]) }];
    while (queue.length) {
      const item = queue.shift()!;
      if (item.roomId === core && requiredGates.some((gate) => !item.gates.includes(gate))) {
        // A path that arrives early at core is an invalid shortcut.
        errors.push(`core path from ${start} bypasses gates`);
        break;
      }
      if (item.roomId === core) continue;
      for (const next of graphNeighbors(layout, item.roomId)) {
        if (item.visited.has(next.roomId)) continue;
        const gates = next.gateId && !item.gates.includes(next.gateId)
          ? [...item.gates, next.gateId]
          : [...item.gates];
        const visited = new Set(item.visited);
        visited.add(next.roomId);
        queue.push({ roomId: next.roomId, gates, visited });
      }
    }
  }
  // Each gate must be the only physical blocker on its segment. Checking the
  // seven variants for both mirrored castles catches a disconnected rear
  // passage or a gate rectangle that misses the authored floor corridor.
  for (const gateId of GATE_IDS) {
    const openExcept = GATE_IDS.filter((candidate) => candidate !== gateId);
    if (canReachCoreOnFloor(layout, "central_corridor", openExcept)) {
      errors.push(`closed ${gateId} does not block physical core route`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateWorldLayout(layout: WorldLayout): LayoutValidationResult {
  const home = validateCastleLayout(layout.home);
  const enemy = validateCastleLayout(layout.enemy);
  const actors = validateActorDefinitionsForLayout(layout);
  const errors = [
    ...home.errors.map((error) => `home: ${error}`),
    ...enemy.errors.map((error) => `enemy: ${error}`),
    ...actors.errors.map((error) => `actors: ${error}`),
  ];
  if (layout.widthCells <= 0 || layout.heightCells <= 0) errors.push("world dimensions must be positive");
  if (layout.mirrorRule.textAndControlsMirrored) errors.push("text/controls must not mirror");
  return { valid: errors.length === 0, errors };
}

export function assertValidWorldLayout(layout: WorldLayout): void {
  const result = validateWorldLayout(layout);
  if (!result.valid) throw new Error(`invalid world layout: ${result.errors.join("; ")}`);
}

export function routeHasAllGates(layout: CastleLayout, pathRooms: readonly string[], targetRoom = "core"): boolean {
  if (targetRoom !== "core" || pathRooms.at(-1) !== "core") return false;
  const route = layout.coreRouteRooms;
  if (pathRooms.length < route.length) return false;
  const offset = pathRooms.length - route.length;
  if (route.some((room, index) => pathRooms[offset + index] !== room)) return false;
  return layout.coreRouteGates.length === GATE_IDS.length;
}

/** Room-graph reachability with the current gate snapshot. */
export function canReachCore(
  layout: CastleLayout,
  fromRoom: string,
  openGates: ReadonlySet<GateId> | readonly GateId[],
): boolean {
  const queue = [fromRoom];
  const visited = new Set(queue);
  while (queue.length) {
    const room = queue.shift()!;
    if (room === "core") return true;
    for (const neighbor of graphNeighbors(layout, room)) {
      if (neighbor.gateId && !(Array.isArray(openGates)
        ? openGates.includes(neighbor.gateId)
        : (openGates as ReadonlySet<GateId>).has(neighbor.gateId))) continue;
      if (!visited.has(neighbor.roomId)) {
        visited.add(neighbor.roomId);
        queue.push(neighbor.roomId);
      }
    }
  }
  return false;
}

export function openGatePrefix(castle: CastleState): number {
  let count = 0;
  for (const gate of GATE_IDS) {
    if (!castle.gates[gate].open) break;
    count += 1;
  }
  return count;
}

export function destroyedPartCount(castle: CastleState): number {
  return PART_IDS.filter((partId) => castle.exterior[partId].destroyed).length;
}

export function actorDefinitionsForLayout(): readonly ActorDefinition[] {
  return actorDefinitions();
}
