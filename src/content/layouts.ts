import rawLayouts from "../../docs/plans/current/INTERIOR_LAYOUTS.json" with { type: "json" };
import type {
  CastleLayout,
  GateId,
  LayoutLink,
  Point,
  RecoveryPad,
  Rect,
  RoomDefinition,
  RoomKind,
  SupplyPortDefinition,
  TeamId,
  TurretDefinition,
  WorldLayout,
} from "../domain/types.ts";
import { GATE_IDS } from "../domain/types.ts";

interface RawPad { id: string; assigned_npc_id?: string; cell: [number, number]; }
interface RawRoom {
  id: string;
  label_ja?: string;
  kind: string;
  rect_cells: [number, number, number, number];
  recovery_pads?: RawPad[];
  player_respawn_pads?: RawPad[];
}
interface RawLink { a: string; b: string; gate_id?: string | null; passage_id?: string; }
interface RawTurret {
  id: string;
  label_ja?: string;
  room_id: string;
  operator_npc_id: string;
  queue_capacity?: number;
  staging_floor_slots?: number;
  cell?: [number, number];
}
interface RawLayout {
  grid: { width_cells: number; height_cells: number };
  rooms: RawRoom[];
  corridor_geometry?: Array<{ id: string; rect_cells: [number, number, number, number] }>;
  passages?: Array<{ id: string; a: string; b: string; rect_cells: [number, number, number, number] }>;
  links: RawLink[];
  gate_route: { from_work_to_core: string[]; gates_in_order: string[] };
  turrets?: RawTurret[];
  supply_ports?: Array<{ id: string; room_id: string; cell?: [number, number] }>;
}

const source = rawLayouts as unknown as RawLayout;

function playerRespawnPadIdsFromDocument(): Record<"P1" | "P2" | "P3", string> {
  const respawn = source.rooms.find((room) => room.id === "respawn");
  const pads = respawn?.player_respawn_pads ?? [];
  const ids = {} as Record<"P1" | "P2" | "P3", string>;
  for (const actorId of ["P1", "P2", "P3"] as const) {
    const pad = pads.find((candidate) => candidate.assigned_npc_id === actorId);
    if (!pad) throw new Error(`INTERIOR_LAYOUTS.json must define player respawn pad for ${actorId}`);
    ids[actorId] = pad.id;
  }
  if (pads.length !== 3 || new Set(Object.values(ids)).size !== 3) {
    throw new Error("INTERIOR_LAYOUTS.json must define exactly three player respawn pads");
  }
  return ids;
}

export const PLAYER_RESPAWN_PAD_IDS = playerRespawnPadIdsFromDocument();

const ROOM_KINDS = new Set<RoomKind>([
  "core", "respawn", "corridor", "repair", "command", "supply", "battery", "security",
]);

const asRoomKind = (value: string): RoomKind => {
  if (!ROOM_KINDS.has(value as RoomKind)) throw new Error(`unknown room kind in INTERIOR_LAYOUTS.json: ${value}`);
  return value as RoomKind;
};
const asGateId = (value: string | null | undefined): GateId | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!/^G[1-7]$/.test(value)) throw new Error(`unknown gate id in INTERIOR_LAYOUTS.json: ${value}`);
  return value as GateId;
};

function rectFromCells(cells: [number, number, number, number]): Rect {
  return { x0: cells[0], y0: cells[1], x1: cells[2], y1: cells[3] };
}

function mirrorPoint(point: Point, widthCells: number): Point {
  return { x: widthCells - 1 - point.x, y: point.y };
}

function mirrorRect(rect: Rect, widthCells: number): Rect {
  return { x0: widthCells - rect.x1, y0: rect.y0, x1: widthCells - rect.x0, y1: rect.y1 };
}

function uniquePads(pads: RecoveryPad[]): RecoveryPad[] {
  const seen = new Set<string>();
  return pads.filter((pad) => {
    const key = `${pad.id}|${pad.actorId}|${pad.roomId}|${pad.cell.x},${pad.cell.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeRooms(side: TeamId, playerSide: boolean): RoomDefinition[] {
  const width = source.grid.width_cells;
  const enemyPads = new Map<string, string>();
  const rawRooms: RawRoom[] = [
    ...source.rooms,
    ...(source.corridor_geometry ?? []).map((corridor) => ({
      id: corridor.id,
      label_ja: corridor.id,
      kind: "corridor",
      rect_cells: corridor.rect_cells,
      recovery_pads: [],
    })),
  ];
  const rooms = rawRooms.map((rawRoom) => {
    const roomId = rawRoom.id;
    const pads = (rawRoom.recovery_pads ?? []).map((rawPad) => {
      enemyPads.set(rawPad.assigned_npc_id ?? rawPad.id, roomId);
      const cell = { x: rawPad.cell[0], y: rawPad.cell[1] };
      return {
        id: rawPad.id,
        actorId: rawPad.assigned_npc_id ?? rawPad.id,
        roomId,
        cell,
        walkable: true,
      };
    });
    const playerPads = (rawRoom.player_respawn_pads ?? []).map((rawPad) => ({
      id: rawPad.id,
      actorId: rawPad.assigned_npc_id ?? rawPad.id,
      roomId,
      cell: { x: rawPad.cell[0], y: rawPad.cell[1] },
      walkable: true,
    }));
    let rect = rectFromCells(rawRoom.rect_cells);
    if (side === "enemy") rect = mirrorRect(rect, width);
    const allPads = playerSide ? playerPads : pads;
    const mirroredPads = side === "enemy"
      ? allPads.map((pad) => ({ ...pad, cell: mirrorPoint(pad.cell, width) }))
      : allPads;
    return {
      id: roomId,
      label: rawRoom.label_ja ?? roomId,
      kind: asRoomKind(rawRoom.kind),
      rect,
      recoveryPads: uniquePads(mirroredPads),
    } satisfies RoomDefinition;
  });

  void enemyPads;
  return rooms;
}

function makeLinks(side: TeamId): LayoutLink[] {
  return source.links.map((link) => ({
    a: link.a,
    b: link.b,
    gateId: asGateId(link.gate_id),
    passageId: link.passage_id,
  }));
}

function uniqueCells(cells: Point[]): Point[] {
  const seen = new Set<string>();
  return cells.filter((cell) => {
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cellsInRect(rect: Rect): Point[] {
  const cells: Point[] = [];
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) cells.push({ x, y });
  }
  return cells;
}

function makeGateCells(side: TeamId, links: LayoutLink[]): Record<GateId, Point[]> {
  const passages = new Map((source.passages ?? []).map((passage) => [passage.id, rectFromCells(passage.rect_cells)]));
  return Object.fromEntries(GATE_IDS.map((gateId) => {
    const cells = links
      .filter((link) => link.gateId === gateId && link.passageId)
      .flatMap((link) => {
        const rect = passages.get(link.passageId!);
        if (!rect) return [];
        return cellsInRect(side === "enemy" ? mirrorRect(rect, source.grid.width_cells) : rect);
      });
    return [gateId, uniqueCells(cells)];
  })) as Record<GateId, Point[]>;
}

function roomCenter(room: RoomDefinition): Point {
  return {
    x: Math.floor((room.rect.x0 + room.rect.x1 - 1) / 2),
    y: Math.floor((room.rect.y0 + room.rect.y1 - 1) / 2),
  };
}

/**
 * The document supplies room rectangles and links. R1 turns each link into a
 * one-cell corridor between room centers so pad reachability can be checked
 * on actual floor cells. This is a structural floor model, not a claim that
 * wall thickness or final collision tuning has been playtested.
 */
function buildFloorCells(rooms: RoomDefinition[], links: LayoutLink[], explicitPassages: Rect[] = []): Point[] {
  const cells = new Map<string, Point>();
  const add = (x: number, y: number): void => {
    if (x < 0 || y < 0) return;
    cells.set(`${x},${y}`, { x, y });
  };
  for (const room of rooms) {
    for (let y = room.rect.y0; y < room.rect.y1; y += 1) {
      for (let x = room.rect.x0; x < room.rect.x1; x += 1) add(x, y);
    }
  }
  // Prefer the authored passage rectangles when available. They expose the
  // real floor shape to the BFS and prevent a graph edge from becoming an
  // invisible teleport. Older design snapshots have no passages, so the
  // centerline fallback keeps those snapshots inspectable.
  if (explicitPassages.length > 0) {
    for (const passage of explicitPassages) {
      for (let y = passage.y0; y < passage.y1; y += 1) {
        for (let x = passage.x0; x < passage.x1; x += 1) add(x, y);
      }
    }
    return [...cells.values()].sort((left, right) => left.y - right.y || left.x - right.x);
  }
  for (const link of links) {
    const from = rooms.find((room) => room.id === link.a);
    const to = rooms.find((room) => room.id === link.b);
    if (!from || !to) continue;
    const a = roomCenter(from);
    const b = roomCenter(to);
    const stepX = a.x <= b.x ? 1 : -1;
    for (let x = a.x; x !== b.x; x += stepX) add(x, a.y);
    add(b.x, a.y);
    const stepY = a.y <= b.y ? 1 : -1;
    for (let y = a.y; y !== b.y; y += stepY) add(b.x, y);
    add(b.x, b.y);
  }
  return [...cells.values()].sort((left, right) => left.y - right.y || left.x - right.x);
}

function makeCastle(side: TeamId, playerSide: boolean): CastleLayout {
  const width = source.grid.width_cells;
  const rawTurrets = source.turrets ?? [];
  const turrets: TurretDefinition[] = rawTurrets.map((turret) => ({
    id: turret.id,
    label: turret.label_ja ?? turret.id,
    roomId: turret.room_id,
    operatorActorId: playerSide ? null : turret.operator_npc_id as TurretDefinition["operatorActorId"],
    queueCapacity: turret.queue_capacity ?? 2,
    stagingFloorSlots: turret.staging_floor_slots ?? 2,
    cell: side === "enemy"
      ? mirrorPoint({ x: turret.cell?.[0] ?? 0, y: turret.cell?.[1] ?? 0 }, width)
      : { x: turret.cell?.[0] ?? 0, y: turret.cell?.[1] ?? 0 },
  }));
  const supplyPorts: SupplyPortDefinition[] = (source.supply_ports ?? []).map((port) => ({
    id: port.id,
    roomId: port.room_id,
    cell: side === "enemy"
      ? mirrorPoint({ x: port.cell?.[0] ?? 0, y: port.cell?.[1] ?? 0 }, width)
      : { x: port.cell?.[0] ?? 0, y: port.cell?.[1] ?? 0 },
  }));
  const rooms = makeRooms(side, playerSide);
  const links = makeLinks(side);
  const explicitPassages = (source.passages ?? []).map((passage) => {
    const rect = rectFromCells(passage.rect_cells);
    return side === "enemy" ? mirrorRect(rect, source.grid.width_cells) : rect;
  });
  const passageCells = Object.fromEntries((source.passages ?? []).map((passage) => {
    const rect = rectFromCells(passage.rect_cells);
    const mirrored = side === "enemy" ? mirrorRect(rect, source.grid.width_cells) : rect;
    return [passage.id, cellsInRect(mirrored)];
  }));
  return {
    side,
    widthCells: width,
    heightCells: source.grid.height_cells,
    frontDirection: side === "player" ? 1 : -1,
    rooms,
    links,
    floorCells: buildFloorCells(rooms, links, explicitPassages),
    gateCells: makeGateCells(side, links),
    passageCells,
    coreRouteRooms: [...source.gate_route.from_work_to_core],
    coreRouteGates: source.gate_route.gates_in_order.map((gate) => gate as GateId),
    turrets,
    supplyPorts,
  };
}

export function createFacingCastlesLayout(): WorldLayout {
  return {
    widthCells: source.grid.width_cells,
    heightCells: source.grid.height_cells,
    home: makeCastle("player", true),
    enemy: makeCastle("enemy", false),
    plaza: { x0: 0, y0: 20, x1: source.grid.width_cells, y1: 50 },
    mirrorRule: {
      point: "125-x,y",
      rect: "126-x1,y0,126-x0,y1",
      direction: "-dx,dy",
      textAndControlsMirrored: false,
    },
  };
}

export const DEFAULT_LAYOUT = createFacingCastlesLayout();

export function mirrorCastleGeometry(castle: CastleLayout, side: TeamId): CastleLayout {
  const width = castle.widthCells;
  const mirrored = side !== castle.side;
  return {
    ...castle,
    side,
    frontDirection: mirrored ? castle.frontDirection === 1 ? -1 : 1 : castle.frontDirection,
    rooms: castle.rooms.map((room) => ({
      ...room,
      rect: mirrored ? mirrorRect(room.rect, width) : { ...room.rect },
      recoveryPads: room.recoveryPads.map((pad) => ({
        ...pad,
        cell: mirrored ? mirrorPoint(pad.cell, width) : { ...pad.cell },
      })),
    })),
    links: castle.links.map((link) => ({ ...link })),
    floorCells: castle.floorCells.map((cell) => mirrored ? mirrorPoint(cell, width) : { ...cell }),
    gateCells: Object.fromEntries(GATE_IDS.map((gateId) => [
      gateId,
      castle.gateCells[gateId].map((cell) => mirrored ? mirrorPoint(cell, width) : { ...cell }),
    ])) as CastleLayout["gateCells"],
    passageCells: castle.passageCells
      ? Object.fromEntries(Object.entries(castle.passageCells).map(([id, cells]) => [
        id,
        cells.map((cell) => mirrored ? mirrorPoint(cell, width) : { ...cell }),
      ]))
      : undefined,
    coreRouteRooms: [...castle.coreRouteRooms],
    coreRouteGates: [...castle.coreRouteGates],
    turrets: castle.turrets.map((turret) => ({ ...turret, cell: mirrored ? mirrorPoint(turret.cell, width) : { ...turret.cell } })),
    supplyPorts: castle.supplyPorts.map((port) => ({ ...port, cell: mirrored ? mirrorPoint(port.cell, width) : { ...port.cell } })),
  };
}

export function roomDefinition(layout: CastleLayout, roomId: string): RoomDefinition | undefined {
  return layout.rooms.find((room) => room.id === roomId);
}
