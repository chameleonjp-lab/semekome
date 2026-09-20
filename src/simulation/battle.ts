import layoutSource from "../../docs/plans/current/INTERIOR_LAYOUTS.json" with { type: "json" };
import { COMBAT_RULES, WEAPONS } from "../content/weapons.ts";
import type { CaseType } from "../content/cases.ts";
import type { BattleState, FloorSample, TurretRuntime } from "../domain/battle.ts";
import { assertObjectLocationsUnique } from "../domain/objects.ts";
import { roomContainsPoint } from "../domain/layout.ts";
import type { CreateWorldOptions, TeamId } from "../domain/types.ts";
import { cloneWorld, createWorld, stepWorld } from "./world.ts";
import { applyClockCommand, type ClockCommand } from "./clock.ts";
import { executeActorCommand, refreshOperators } from "./battle-actions.ts";
import { advanceArtillery, launchReadyTurrets } from "./artillery.ts";
import { updateEnemyDecisions } from "./enemy-rules.ts";
import {
  commitCommonSupplySpawns,
  commonSupplyInputs,
  createCommonSupplyState,
  prepareCommonSupplySpawns,
} from "./common-supply.ts";
import {
  commonDeliveryHandoffInputs,
  commonDeliveryInputs,
  commonDeliveryMovementInputs,
  prepareCommonDeliveryPlans,
} from "./common-delivery.ts";

export interface CreateBattleOptions extends CreateWorldOptions {
  difficulty?: "easy" | "standard" | "hard";
  /** Player-only loadout; enemy supply remains internal and unpreviewable. */
  playerSupplyAllocation?: readonly CaseType[];
}

export function createBattle(options: CreateBattleOptions = {}): BattleState {
  const world = createWorld(options);
  if (world.rules.ticksPerSecond !== 60) throw new Error("R2a battle requires the v5 60 Hz clock");
  const turrets = (team: TeamId): Record<string, TurretRuntime> => Object.fromEntries(
    (team === "player" ? world.layout.home : world.layout.enemy).turrets.map(t => [t.id, { settings: { route: "direct", partId: "P1" }, operator: null, disabledUntilTick: null }]),
  );
  for (const actor of Object.values(world.actors)) actor.turretControlIds = [];
  const stop = () => ({ disruptedUntil: 0, immuneUntil: 0, equipmentDisabledUntil: null });
  return {
    world, catalog: structuredClone(WEAPONS), turrets: { player: turrets("player"), enemy: turrets("enemy") }, queued: {}, flights: {},
    nextLaunchTick: { player: 0, enemy: 0 }, nextTurretIndex: { player: 0, enemy: 0 },
    supplyStops: { player: stop(), enemy: stop() },
    supply: createCommonSupplyState(world, { playerAllocation: options.playerSupplyAllocation }),
    slowZones: {}, enemyDecisions: {},
    enemyDecisionInterval: options.difficulty === "easy" ? 36 : options.difficulty === "hard" ? 11 : 18,
    interceptedPairs: [], nextId: 1, lastCombatStep: { rejected: [], events: [] },
  };
}

export function cloneBattle(battle: BattleState): BattleState {
  const { world, ...runtime } = battle;
  return { ...structuredClone(runtime), world: cloneWorld(world) };
}

export function assertBattleConsistent(battle: BattleState): void {
  assertObjectLocationsUnique(battle.world);
  if (Object.keys(battle.flights).length > COMBAT_RULES.projectileLimit) throw new Error("projectile capacity exceeded");
  for (const object of Object.values(battle.world.objects)) {
    if (!object.weaponId || !Object.hasOwn(battle.catalog, object.weaponId) || battle.catalog[object.weaponId].weight !== object.weight) throw new Error("R2 case requires valid catalog ID and weight");
    if ((object.location.kind === "queue") !== Object.hasOwn(battle.queued, object.id)) throw new Error("missing/orphaned queue snapshot");
  }
  for (const id of Object.keys(battle.queued)) if (!Object.hasOwn(battle.world.objects, id)) throw new Error("queue snapshot without object");
  for (const [id, projectile] of Object.entries(battle.world.projectiles)) {
    const flight = battle.flights[id];
    if (!flight || flight.id !== id || flight.partId !== projectile.targetPartId) throw new Error("missing/mismatched flight state");
  }
  for (const id of Object.keys(battle.flights)) if (!Object.hasOwn(battle.world.projectiles, id)) throw new Error("flight without projectile");
}

/** Keep the battle-only firing snapshot aligned with common queue transitions. */
function syncQueuedSnapshots(battle: BattleState): void {
  const queuedIds = new Set<string>();
  for (const object of Object.values(battle.world.objects)) {
    if (object.location.kind !== "queue") continue;
    queuedIds.add(object.id);
    if (Object.hasOwn(battle.queued, object.id)) continue;
    const turret = battle.turrets[object.location.team][object.location.turretId];
    if (!turret) throw new Error(`missing runtime for queued turret ${object.location.team}:${object.location.turretId}`);
    battle.queued[object.id] = { ...turret.settings };
  }
  for (const id of Object.keys(battle.queued)) if (!queuedIds.has(id)) delete battle.queued[id];
}

/** Public R2 command boundary. Caller may control P1, never impersonate NPCs.
 * Low-level R1 collision events are deliberately not accepted here.
 */
export function stepBattle(battle: BattleState, inputs: readonly unknown[] = []): BattleState {
  assertBattleConsistent(battle);
  const next = cloneBattle(battle);
  next.lastCombatStep = { rejected: [], events: [] };
  const reject = (index: number, reason: string): void => { next.lastCombatStep.rejected.push({ index, reason }); };
  const actions: Array<{ index: number; command: Record<string, unknown> }> = [];
  let pauseRequested = false;
  for (const [index, raw] of inputs.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { reject(index, "invalid_command"); continue; }
    const command = raw as Record<string, unknown>;
    if (command.matchId !== next.world.matchId) { reject(index, "wrong_match"); continue; }
    if (next.world.phase === "ended") { reject(index, "ended"); continue; }
    if (command.kind === "pause" || command.kind === "resume" || command.kind === "visibility") {
      if (command.kind === "visibility" && typeof command.visible !== "boolean") { reject(index, "invalid_visibility"); continue; }
      if (command.kind === "pause" || command.kind === "visibility" && !command.visible) pauseRequested = true;
      applyClockCommand(next.world, command as unknown as ClockCommand);
    } else {
      actions.push({ index, command });
    }
  }
  if (next.world.phase !== "running" || pauseRequested) {
    for (const { index } of actions) reject(index, next.world.phase === "ended" ? "ended" : "paused");
    next.world.lastStep = { advanced: false, processedTick: null, acceptedInputKinds: [], rejected: [], events: [] };
    return next;
  }
  refreshOperators(next);
  for (const { index, command } of actions) {
    if (!["pickup", "load", "operate", "release", "aim"].includes(String(command.kind))) { reject(index, "unsupported_command"); continue; }
    if (command.actorId !== "P1") { reject(index, "not_controlled_actor"); continue; }
    const reason = executeActorCommand(next, command);
    if (reason) reject(index, reason);
  }
  updateEnemyDecisions(next);
  for (const team of ["player", "enemy"] as const) {
    const zone = next.slowZones[team];
    if (zone && next.world.tick >= zone.expiresAt) delete next.slowZones[team];
  }
  const damage = advanceArtillery(next);
  launchReadyTurrets(next);
  const deliveryPlans = prepareCommonDeliveryPlans(next);
  const deliveryInputs = [
    ...commonDeliveryInputs(deliveryPlans),
    ...commonDeliveryMovementInputs(next),
    ...commonDeliveryHandoffInputs(next),
  ];
  const supplyPlans = prepareCommonSupplySpawns(next);
  next.world = stepWorld(next.world, [...damage, ...deliveryInputs, ...commonSupplyInputs(supplyPlans)]);
  syncQueuedSnapshots(next);
  commitCommonSupplySpawns(next, supplyPlans, damage.length + deliveryInputs.length, next.world.lastStep);
  refreshOperators(next);
  for (const [id, decision] of Object.entries(next.enemyDecisions)) {
    const actor = next.world.actors[id];
    if (!actor.alive || actor.generation !== decision.generation || next.world.phase === "ended") delete next.enemyDecisions[id];
  }
  assertBattleConsistent(next);
  return next;
}

/** R3 supply producer must query both independent stop reasons. */
export function canSupplyProduce(battle: BattleState, team: TeamId): boolean {
  const stop = battle.supplyStops[team];
  return battle.world.phase === "running" && battle.world.tick >= stop.disruptedUntil &&
    (stop.equipmentDisabledUntil === null || battle.world.tick > stop.equipmentDisabledUntil);
}

/** R2b movement will consume this multiplier; it does not itself move actors. */
export function movementMultiplier(battle: BattleState, sample: FloorSample, carriedWeight: number): number {
  let multiplier = carriedWeight >= COMBAT_RULES.carryWeight ? COMBAT_RULES.heavyMultiplier : 1;
  const [homeX, y] = layoutSource.front_entry.cell;
  const layout = sample.castleTeam === "player" ? battle.world.layout.home : battle.world.layout.enemy;
  const center = { x: sample.castleTeam === "player" ? homeX : layout.widthCells - 1 - homeX, y };
  const entryRoom = layout.rooms.find(room => room.id === layoutSource.front_entry.room_id);
  if (!entryRoom || !roomContainsPoint(entryRoom, center)) throw new Error("slow zone entry is outside floor");
  for (const zone of Object.values(battle.slowZones)) {
    if (zone.targetTeam === sample.castleTeam && battle.world.tick < zone.expiresAt && sample.roomId === layoutSource.front_entry.room_id &&
      (sample.position.x - center.x) ** 2 + (sample.position.y - center.y) ** 2 <= zone.radius ** 2) multiplier *= zone.multiplier;
  }
  return multiplier;
}
