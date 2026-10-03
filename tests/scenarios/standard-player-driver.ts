import { getInteraction, type BattleState, type BattleDirection, type BattleIntent } from "../../src/simulation/physical-battle.ts";
const NEUTRAL: BattleDirection = { x: 0, y: 0 };
const PLAZA_Y = 35_500;
const P1_AMMO_APPROACH_X = 94_500;
const P1_AMMO_PICKUP_Y = 12_500;
const P1_TURRET_TRAVEL_Y = 12_000;
const P1_TURRET_APPROACH_X = 105_850;
const P1_EXIT_ROUTE_Y = 25_500;
const P1_EXIT_X = 123_500;
const PLAZA_GUARD_IDS = ["E25", "E26", "E27"] as const;
const STANDARD_ALLOCATION = [
  "standard_slug", "standard_slug", "standard_slug",
  "dense_payload", "dense_payload", "screen_panel", "screen_panel", "fast_dart",
] as const;

function publicP1Intent(state: BattleState, partial: Partial<BattleIntent> = {}): BattleIntent {
  return {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    ...partial,
  };
}

function sign(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function p1ToAmmoDirection(state: BattleState, firstPickup: boolean): BattleDirection {
  const position = state.fixedActors.P1.position;
  // Cases now spawn on walkable cells around the port. Approach the actual
  // floor case from above the equipment instead of walking into its body.
  const candidate = Object.values(state.battleCases)
    .filter(item => item.currentTeam === "player" && item.location === "floor" && item.roomId === "ammo_a")
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id))[0];
  const target = candidate?.position ?? { x: P1_AMMO_APPROACH_X, y: P1_AMMO_PICKUP_Y };
  const sign = (value: number): -1 | 0 | 1 => value > 0 ? 1 : value < 0 ? -1 : 0;
  if (position.y > 25_500 && Math.abs(position.x - P1_AMMO_APPROACH_X) > 50)
    return { x: sign(P1_AMMO_APPROACH_X - position.x), y: 0 };
  if (Math.abs(position.x - target.x) > 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: sign(target.x - position.x), y: 0 };
  }
  return { x: 0, y: sign(target.y - position.y) };
}

function isNearPlayerTurret(state: BattleState): boolean {
  const turret = state.artillery.turrets["player:T1"];
  const position = state.fixedActors.P1.position;
  return (position.x - turret.position.x) ** 2 + (position.y - turret.position.y) ** 2 <= 800 ** 2;
}

function p1ToTurretDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (position.x < P1_TURRET_APPROACH_X - 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: 1, y: 0 };
  }
  if (!isNearPlayerTurret(state)) return { x: 0, y: 1 };
  return NEUTRAL;
}

function p1ToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  // A delayed siege impact can finish while P1 is collecting the next case.
  // Leave the ammo equipment via its clear upper edge before heading south.
  if (position.y < 20_000 && position.x < P1_AMMO_APPROACH_X - 50) {
    if (position.y > P1_TURRET_TRAVEL_Y + 50) return { x: 0, y: -1 };
    return { x: 1, y: 0 };
  }
  if (Math.abs(position.x - P1_EXIT_X) > 50) {
    if (Math.abs(position.y - P1_EXIT_ROUTE_Y) > 50) return { x: 0, y: sign(P1_EXIT_ROUTE_Y - position.y) };
    return { x: sign(P1_EXIT_X - position.x), y: 0 };
  }
  if (Math.abs(position.y - PLAZA_Y) > 50) return { x: 0, y: sign(PLAZA_Y - position.y) };
  return { x: 1, y: 0 };
}

function p1FromRespawnToPlazaDirection(state: BattleState): BattleDirection {
  const position = state.fixedActors.P1.position;
  if (Math.abs(position.y - PLAZA_Y) > 50) return { x: 0, y: sign(PLAZA_Y - position.y) };
  if (position.x < 66_500) return { x: 1, y: 0 };
  if (Math.abs(position.x - P1_EXIT_X) > 50) return { x: sign(P1_EXIT_X - position.x), y: 0 };
  return { x: 1, y: 0 };
}

function p1ToEnemyCastleDirection(state: BattleState): BattleDirection {
  const enemyPlazaEdgeX = state.layout.plaza.x1 * 1_000 - 500;
  const direction = {
    x: sign(enemyPlazaEdgeX - state.fixedActors.P1.position.x),
    y: sign(PLAZA_Y - state.fixedActors.P1.position.y),
  };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

function p1ToActorDirection(state: BattleState, actorId: string): BattleDirection {
  const position = state.fixedActors.P1.position;
  const target = state.fixedActors[actorId]?.position;
  if (!target) {
    if (PLAZA_GUARD_IDS.some((guardId) => state.actors[guardId].alive)) return NEUTRAL;
    return p1ToEnemyCastleDirection(state);
  }
  // Cardinal weapons need a firing lane; diagonal pursuit is not aiming.
  const dx = target.x - position.x, dy = target.y - position.y;
  const direction: BattleDirection = Math.abs(dy) > 300 && Math.abs(dx) > 300
    ? { x: 0, y: sign(dy) }
    : Math.abs(dx) >= Math.abs(dy) ? { x: sign(dx), y: 0 } : { x: 0, y: sign(dy) };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

function nearestEnemyInP1Room(state: BattleState): string | undefined {
  const player = state.actors.P1;
  const position = state.fixedActors.P1.position;
  const target = Object.values(state.actors)
    .filter((actor) => actor.team === "enemy" && actor.alive && actor.location.area === player.location.area &&
      actor.currentRoomId === player.currentRoomId && actor.location.castleTeam === player.location.castleTeam &&
      Math.hypot(state.fixedActors[actor.id].position.x - position.x, state.fixedActors[actor.id].position.y - position.y) <= 8_000)
    .sort((left, right) => {
      const leftPosition = state.fixedActors[left.id].position;
      const rightPosition = state.fixedActors[right.id].position;
      return (leftPosition.x - position.x) ** 2 + (leftPosition.y - position.y) ** 2 -
        ((rightPosition.x - position.x) ** 2 + (rightPosition.y - position.y) ** 2) || left.id.localeCompare(right.id);
    })[0];
  if (!target) return undefined;
  const targetPosition = state.fixedActors[target.id].position;
  const engagementRange = 8_000;
  return (targetPosition.x - position.x) ** 2 + (targetPosition.y - position.y) ** 2 <= engagementRange ** 2
    ? target.id
    : undefined;
}

function nearestLiveGuardId(state: BattleState): (typeof PLAZA_GUARD_IDS)[number] | undefined {
  const position = state.fixedActors.P1.position;
  return PLAZA_GUARD_IDS
    .map((actorId) => state.actors[actorId])
    .filter((actor) => actor.alive && actor.location.area === "plaza")
    .map((actor) => ({ actor, position: state.fixedActors[actor.id]!.position }))
    .sort((left, right) => {
      const leftDistance = (left.position.x - position.x) ** 2 + (left.position.y - position.y) ** 2;
      const rightDistance = (right.position.x - position.x) ** 2 + (right.position.y - position.y) ** 2;
      return leftDistance - rightDistance || left.actor.id.localeCompare(right.actor.id);
    })[0]?.actor.id as (typeof PLAZA_GUARD_IDS)[number] | undefined;
}

function p1ToNearestGuardDirection(state: BattleState, preferredGuardId?: (typeof PLAZA_GUARD_IDS)[number]): BattleDirection {
  const position = state.fixedActors.P1.position;
  const candidates = PLAZA_GUARD_IDS
    .map((actorId) => state.actors[actorId])
    .filter((actor) => actor.alive && actor.location.area === "plaza")
    .map((actor) => ({ actor, position: state.fixedActors[actor.id].position }));
  const preferred = preferredGuardId ? candidates.find((candidate) => candidate.actor.id === preferredGuardId) : undefined;
  const target = preferred ?? candidates.sort((left, right) => {
    const healthDelta = left.actor.health - right.actor.health;
    const leftDistance = (left.position.x - position.x) ** 2 + (left.position.y - position.y) ** 2;
    const rightDistance = (right.position.x - position.x) ** 2 + (right.position.y - position.y) ** 2;
    return healthDelta || leftDistance - rightDistance || left.actor.id.localeCompare(right.actor.id);
  })[0];
  if (!target) return p1ToEnemyCastleDirection(state);
  const laneY = preferredGuardId
    ? Math.max(state.layout.plaza.y0 * 1_000 + 1_000, target.position.y - 7_000)
    : target.position.y;
  if (Math.abs(target.position.x - position.x) > 50) {
    if (Math.abs(position.y - laneY) > 50) return { x: 0, y: sign(laneY - position.y) };
    return { x: sign(target.position.x - position.x), y: 0 };
  }
  if (Math.abs(target.position.y - position.y) > 50) return { x: 0, y: sign(target.position.y - position.y) };
  const direction = { x: sign(target.position.x - position.x), y: sign(target.position.y - position.y) };
  return direction.x === 0 && direction.y === 0 ? { x: 1, y: 0 } : direction;
}

export function createStandardPlayerDriver(deliveryTarget = 4, regroupWithSupports = false, usePublicSupportOrders = false) {
  let phase: "pickup" | "turret" | "plaza-route" | "return-plaza" | "combat" | "gate-route" | "core-route" = "pickup";
  let deliveries = 0, lastTick = -1, wasAlive = true;
  let focusGuardId: (typeof PLAZA_GUARD_IDS)[number] | undefined;
  const choose = (state: BattleState, intent: BattleIntent): BattleIntent => {
    // The live UI supports following P1 and artillery, without room selectors.
    const p1 = state.actors.P1;
    const position = state.fixedActors.P1.position;
    const leavingHome = p1.location.castleTeam === 'player' && position.x > 105_000 && position.y > 20_000;
    if (usePublicSupportOrders && (leavingHome || p1.location.area === 'plaza' || p1.location.castleTeam === 'enemy')) {
      const kind = leavingHome || p1.location.area === 'plaza' || p1.location.pathGates.length === 0 ? 'follow' : 'artillery';
      const part = (Object.keys(state.castles.enemy.exterior) as Array<keyof typeof state.castles.enemy.exterior>)
        .find(id => !state.castles.enemy.exterior[id].destroyed) ?? 'P7';
      const allyId = (['P2', 'P3'] as const).find(id => state.actors[id].alive &&
        (state.allyOrders[id]?.kind !== kind || kind === 'artillery' &&
          (state.allyOrders[id]?.route !== 'detour' || state.allyOrders[id]?.part !== part)));
      if (allyId) intent.allyCommand = { allyId, kind, ...(kind === 'artillery' ? { route: 'detour', part } : {}) };
    }
    return intent;
  };
  return (state: BattleState): BattleIntent | undefined => {
    if (state.phase !== 'running') return;
    if (state.tick !== lastTick) {
      lastTick = state.tick;
      if (phase === 'pickup' && state.actors.P1.cargoIds.length > 0) phase = 'turret';
      if (state.lastStep.acceptedInputKinds.includes('handle:deliver')) { deliveries++; phase = deliveries < deliveryTarget ? 'pickup' : 'plaza-route'; }
      if (focusGuardId && !state.actors[focusGuardId].alive) focusGuardId = undefined;
      if (state.actors.P1.alive && !wasAlive) { focusGuardId = undefined; phase = deliveries === 0 ? 'pickup' : 'return-plaza'; }
      wasAlive = state.actors.P1.alive;
      if (state.actors.P1.location.area === 'plaza') phase = 'combat';
      if (state.actors.P1.location.area === 'castle' && state.actors.P1.location.castleTeam === 'enemy') phase = state.actors.P1.location.pathGates.length === 7 ? 'core-route' : 'gate-route';
    }
    if (!state.actors.P1.alive) return;
    if ((regroupWithSupports || usePublicSupportOrders) && state.actors.P1.location.area === 'plaza' &&
        state.fixedActors.P1.position.x >= state.layout.plaza.x1 * 1000 - 2500 && !nearestEnemyInP1Room(state)) {
      const p1 = state.fixedActors.P1.position;
      if (['P2','P3'].some(id => !state.actors[id].alive || state.actors[id].location.area !== 'plaza' ||
          Math.hypot(state.fixedActors[id].position.x - p1.x,state.fixedActors[id].position.y - p1.y) > 1500)) return choose(state,publicP1Intent(state,{direction:NEUTRAL}));
    }
    if (phase === 'combat' && state.actors.P1.location.area !== 'plaza') phase = 'return-plaza';
    if (state.actors.P1.location.area === 'plaza') {
      const threat = nearestEnemyInP1Room(state);
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      if (state.dashes.P1) return choose(state,publicP1Intent(state,{direction:NEUTRAL}));
      if (threat) return choose(state,publicP1Intent(state,{direction:p1ToActorDirection(state,threat),shoot:true}));
    }
    const coreRoom = state.layout.enemy.rooms.find(room => room.id === 'core')!;
    const coreCenter = { x: Math.round((coreRoom.rect.x0 + coreRoom.rect.x1) * 500), y: Math.round((coreRoom.rect.y0 + coreRoom.rect.y1) * 500) };
    let nextState: BattleIntent;
    if (phase === "pickup") {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      nextState = interaction.handles.includes("load")
        ? choose(state, publicP1Intent(state, { handle: "load", slot: Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)), contextToken: interaction.contextToken }))
        : choose(state, publicP1Intent(state, { direction: p1ToAmmoDirection(state, deliveries === 0) }));
    } else if (phase === "turret") {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      nextState = interaction.handles.includes("deliver")
        ? choose(state, publicP1Intent(state, { handle: "deliver", slot: Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)), route: "detour", part: "P1", contextToken: interaction.contextToken }))
        : choose(state, publicP1Intent(state, { direction: p1ToTurretDirection(state) }));
    } else if (phase === "plaza-route" || phase === "return-plaza") {
      const position = state.fixedActors.P1.position;
      const regroup = usePublicSupportOrders && position.x >= 122_500 && position.y >= 35_000 && ['P2', 'P3'].some(id =>
        !state.actors[id].alive || state.actors[id].location.castleTeam !== 'player' ||
        Math.hypot(state.fixedActors[id].position.x - position.x, state.fixedActors[id].position.y - position.y) > 1_500);
      nextState = choose(state, publicP1Intent(state, {
        direction: regroup ? NEUTRAL : phase === "return-plaza" ? p1FromRespawnToPlazaDirection(state) : p1ToPlazaDirection(state),
      }));
    } else if (phase === "gate-route" || phase === "core-route") {
      const corridorPosition = state.fixedActors.P1.position;
      const inEntryCorridor = state.actors.P1.currentRoomId === "central_corridor";
      const candidateThreat = nearestEnemyInP1Room(state);
      const threatId = candidateThreat && (!inEntryCorridor ||
        state.fixedActors[candidateThreat].position.x >= corridorPosition.x - 500 &&
        Math.abs(state.fixedActors[candidateThreat].position.y - corridorPosition.y) < 800)
        ? candidateThreat : undefined;
      const corridorDirection: BattleDirection = corridorPosition.x < 3_500 ? { x: 1, y: 0 }
        : corridorPosition.x < 58_500
          ? Math.abs(corridorPosition.y - 43_500) > 50 ? { x: 0, y: sign(43_500 - corridorPosition.y) } : { x: 1, y: 0 }
          : Math.abs(corridorPosition.y - PLAZA_Y) > 50 ? { x: 0, y: sign(PLAZA_Y - corridorPosition.y) } : { x: 1, y: 0 };
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      const targetPosition = threatId ? state.fixedActors[threatId]?.position : undefined;
      const p1Position = state.fixedActors.P1.position;
      const distance = targetPosition ? Math.hypot(targetPosition.x - p1Position.x, targetPosition.y - p1Position.y) : Number.POSITIVE_INFINITY;
      const direction = threatId ? p1ToActorDirection(state, threatId) : inEntryCorridor ? corridorDirection : { x: 1, y: 0 } as BattleDirection;
      const dashReady = state.tick >= (state.dashCooldownUntilTick.P1 ?? 0);
      const isInEnemyCoreRoom = state.actors.P1.currentRoomId === "core" &&
        state.actors.P1.location.pathGates.join(",") === "G1,G2,G3,G4,G5,G6,G7";
      if (state.dashes.P1) {
        nextState = choose(state, publicP1Intent(state, { direction: NEUTRAL }));
      } else if (threatId) {
        nextState = choose(state, publicP1Intent(state, { direction, shoot: true }));
      } else if (threatId && dashReady && distance <= state.rules.dashDistanceSubunits + 1_000) {
        nextState = choose(state, publicP1Intent(state, { direction: NEUTRAL, mobilityDash: direction }));
      } else if (phase === "core-route" && isInEnemyCoreRoom &&
          Math.abs(coreCenter.y - p1Position.y) > 50) {
        nextState = choose(state, publicP1Intent(state, {
          direction: { x: 0, y: sign(coreCenter.y - p1Position.y) },
        }));
      } else if (phase === "core-route" && isInEnemyCoreRoom &&
          Math.abs(coreCenter.x - p1Position.x) <= 8_000) {
        const coreShotDirection = { x: sign(coreCenter.x - p1Position.x) || 1, y: 0 } as BattleDirection;
        nextState = choose(state, publicP1Intent(state, { direction: coreShotDirection, shoot: true }));
      } else {
        const coreApproachDirection = phase === "core-route" && isInEnemyCoreRoom
          ? { x: sign(coreCenter.x - p1Position.x), y: Math.abs(coreCenter.y - p1Position.y) > 50 ? sign(coreCenter.y - p1Position.y) : 0 } as BattleDirection
          : direction;
        nextState = choose(state, publicP1Intent(state, { direction: coreApproachDirection }));
      }
    } else {
      const interaction = getInteraction(state, "P1", Math.max(0, state.cargoSlots.P1.findIndex(id => id !== null)));
      // A defeated generation respawns at its authored home pad after 20s;
      // home-castle guards do not recreate the old plaza blockade.  The
      // crossing decision therefore waits only for live guards physically in
      // the plaza, not for every actor generation to remain dead.
      const allGuardsClearedFromPlaza = PLAZA_GUARD_IDS.every((actorId) =>
        !state.actors[actorId].alive || state.actors[actorId].location.area !== "plaza");
      const dashReady = state.tick >= (state.dashCooldownUntilTick.P1 ?? 0);
      if (state.dashes.P1) {
        nextState = choose(state, publicP1Intent(state, { direction: NEUTRAL }));
      } else if (interaction.attackTargetId && PLAZA_GUARD_IDS.includes(interaction.attackTargetId as (typeof PLAZA_GUARD_IDS)[number])) {
        const targetId = interaction.attackTargetId;
        nextState = choose(state, publicP1Intent(state, { direction: p1ToActorDirection(state, targetId), shoot: true }));
      } else if (allGuardsClearedFromPlaza) {
        if (!state.castles.enemy.openGateIds.includes("G1")) {
          nextState = choose(state, publicP1Intent(state, { direction: NEUTRAL }));
        } else {
          const direction = p1ToEnemyCastleDirection(state);
          nextState = choose(state, publicP1Intent(state, { direction }));
        }
      } else {
        if (!focusGuardId || !state.actors[focusGuardId].alive) focusGuardId = nearestLiveGuardId(state);
        const focusDirection = focusGuardId ? p1ToActorDirection(state, focusGuardId) : NEUTRAL;
        const focusPosition = focusGuardId ? state.fixedActors[focusGuardId]?.position : undefined;
        const focusDistance = focusPosition
          ? Math.hypot(focusPosition.x - state.fixedActors.P1.position.x, focusPosition.y - state.fixedActors.P1.position.y)
          : Number.POSITIVE_INFINITY;
        const focusActor = focusGuardId ? state.actors[focusGuardId] : undefined;
        const focusSharesPlazaSpace = focusActor?.location.area === "plaza" &&
          state.actors.P1.location.area === "plaza" && focusActor.currentRoomId === state.actors.P1.currentRoomId;
        if (focusGuardId && focusSharesPlazaSpace) {
          nextState = choose(state, publicP1Intent(state, { direction: focusDirection, shoot: true }));
        } else if (focusGuardId && dashReady && focusDistance <= state.rules.dashDistanceSubunits + 1_000) {
          nextState = choose(state, publicP1Intent(state, { direction: NEUTRAL, mobilityDash: focusDirection }));
        } else {
          nextState = choose(state, publicP1Intent(state, { direction: p1ToNearestGuardDirection(state, focusGuardId) }));
        }
      }
    }
    return nextState;
  };
}
