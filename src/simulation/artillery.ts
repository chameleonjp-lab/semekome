import { COMBAT_RULES } from "../content/weapons.ts";
import type { BattleState, Flight } from "../domain/battle.ts";
import { PART_IDS } from "../domain/types.ts";
import type { DamagePartInput, ProjectileState, TeamId } from "../domain/types.ts";
import { equipmentReady, ordered, queueFor, validOperator } from "./battle-actions.ts";

const otherTeam = (team: TeamId): TeamId => team === "player" ? "enemy" : "player";
const length = (battle: BattleState, flight: Flight): number => COMBAT_RULES.routeLengths[flight.route] * battle.world.rules.ticksPerSecond;
const pairKey = (a: string, b: string): string => JSON.stringify([a, b].sort(ordered));

function consume(battle: BattleState, id: string, reason: string): void {
  const projectile = battle.world.projectiles[id];
  battle.world.objects[projectile.objectId].location = { kind: "consumed", reason, tick: battle.world.tick };
  delete battle.world.projectiles[id];
  delete battle.flights[id];
}

function freshId(battle: BattleState): string {
  let id: string;
  do { id = `combat-${battle.nextId++}`; } while (Object.hasOwn(battle.world.objects, id) || Object.hasOwn(battle.world.projectiles, id));
  return id;
}

/** Ready turrets share a single non-bankable slot per vehicle. */
export function launchReadyTurrets(battle: BattleState): void {
  for (const team of ["player", "enemy"] as const) {
    if (battle.world.tick < battle.nextLaunchTick[team]) continue;
    battle.nextLaunchTick[team] = battle.world.tick + COMBAT_RULES.cooldown[team];
    const ids = Object.keys(battle.turrets[team]).sort(ordered);
    for (let offset = 0; offset < ids.length; offset++) {
      const index = (battle.nextTurretIndex[team] + offset) % ids.length;
      const id = ids[index];
      const turret = battle.turrets[team][id];
      const actor = validOperator(battle, team, id);
      const queued = queueFor(battle, team, id);
      const object = queued[0];
      const weapon = object?.weaponId && battle.catalog[object.weaponId];
      const settings = object && battle.queued[object.id];
      if (!actor || !equipmentReady(battle, turret) || !weapon || !settings || Object.keys(battle.flights).length >= COMBAT_RULES.projectileLimit) continue;
      const projectileId = freshId(battle);
      battle.world.projectiles[projectileId] = {
        id: projectileId, objectId: object.id, team, sourceActorId: actor.id, sourceGeneration: actor.generation,
        targetTeam: otherTeam(team), targetPartId: settings.partId,
      };
      battle.flights[projectileId] = {
        id: projectileId, ...settings, bornTick: battle.world.tick, progress: 0,
        speed: weapon.speed, durability: weapon.durability, damage: weapon.damage,
        effects: structuredClone(weapon.effects), splitAttempted: false,
      };
      object.location = { kind: "flying", projectileId };
      for (const remaining of queued.slice(1)) if (remaining.location.kind === "queue") remaining.location.index--;
      delete battle.queued[object.id];
      battle.nextTurretIndex[team] = (index + 1) % ids.length;
      battle.lastCombatStep.events.push({ kind: "launch", tick: battle.world.tick, team, turretId: id, projectileId });
      break;
    }
  }
}

type TimelineEvent = { numerator: number; denominator: number; key: string } &
  ({ kind: "intercept"; a: string; b: string } | { kind: "impact"; id: string });

function impact(battle: BattleState, flight: Flight, damage: DamagePartInput[]): void {
  const projectile = battle.world.projectiles[flight.id];
  const castle = battle.world.castles[projectile.targetTeam];
  // No exterior damage is applied until stepWorld, so every impact sees the
  // same tick-start health and cannot spill into a new part mid-tick.
  const partId = !castle.exterior[flight.partId].destroyed ? flight.partId : PART_IDS.find(id => !castle.exterior[id].destroyed);
  if (partId && flight.damage > 0) damage.push({ kind: "damage_part", team: projectile.targetTeam, partId, amount: flight.damage, source: "projectile", matchId: battle.world.matchId });
  for (const effect of flight.effects) {
    if (effect.kind === "disrupt") {
      const stop = battle.supplyStops[projectile.targetTeam];
      if (battle.world.tick >= stop.immuneUntil) {
        stop.disruptedUntil = battle.world.tick + effect.duration;
        stop.immuneUntil = stop.disruptedUntil + effect.immunity;
      }
    } else if (effect.kind === "slow") {
      battle.slowZones[projectile.team] = {
        sourceTeam: projectile.team, targetTeam: projectile.targetTeam, expiresAt: battle.world.tick + effect.duration,
        radius: effect.radius, multiplier: effect.multiplier,
      };
    }
  }
  battle.lastCombatStep.events.push({ kind: "impact", tick: battle.world.tick, projectileId: flight.id, partId: partId ?? null, damage: partId ? flight.damage : 0 });
  consume(battle, flight.id, "impact");
}

function trySplit(battle: BattleState, parent: Flight): void {
  const effect = parent.effects.find(e => e.kind === "split");
  if (!effect || effect.kind !== "split" || parent.splitAttempted || parent.progress < length(battle, parent) / 2) return;
  parent.splitAttempted = true;
  if (Object.keys(battle.flights).length - 1 + effect.children > COMBAT_RULES.projectileLimit) {
    battle.lastCombatStep.events.push({ kind: "split_blocked", tick: battle.world.tick, parentId: parent.id });
    return;
  }
  const projectile = battle.world.projectiles[parent.id];
  const object = battle.world.objects[projectile.objectId];
  const childIds: string[] = [];
  consume(battle, parent.id, "split");
  for (let index = 0; index < effect.children; index++) {
    const id = freshId(battle);
    childIds.push(id);
    battle.world.objects[id] = { ...object, id, parentObjectId: object.id, originGroupId: object.originGroupId ?? object.id, location: { kind: "flying", projectileId: id } };
    battle.world.projectiles[id] = { ...projectile, id, objectId: id };
    battle.flights[id] = {
      ...parent, id, bornTick: battle.world.tick,
      // Children trail the parent, do not jump forward towards the target.
      progress: Math.max(0, parent.progress - index * effect.spacing * battle.world.rules.ticksPerSecond),
      speed: effect.speed, durability: effect.durability, damage: effect.damage,
      effects: parent.effects.filter(e => e.kind !== "split"), splitAttempted: true,
    };
  }
  battle.lastCombatStep.events.push({ kind: "split", tick: battle.world.tick, parentId: parent.id, childIds });
}

/** Swept point contact on each 1-D route; fractions are compared by products. */
export function advanceArtillery(battle: BattleState): DamagePartInput[] {
  const damage: DamagePartInput[] = [];
  const active = Object.values(battle.flights).filter(f => f.bornTick < battle.world.tick).sort((a, b) => ordered(a.id, b.id));
  const events: TimelineEvent[] = [];
  const seen = new Set(battle.interceptedPairs);
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    const remaining = length(battle, a) - a.progress;
    if (remaining <= a.speed) events.push({ kind: "impact", id: a.id, numerator: Math.max(0, remaining), denominator: a.speed, key: a.id });
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      const pa: ProjectileState = battle.world.projectiles[a.id];
      const pb = battle.world.projectiles[b.id];
      const key = pairKey(a.id, b.id);
      if (a.route !== b.route || pa.team === pb.team || seen.has(key)) continue;
      const gap = length(battle, a) - a.progress - b.progress;
      const closingSpeed = a.speed + b.speed;
      if (gap < 0 || gap > closingSpeed) continue;
      // The contact must precede either target boundary.
      if (gap * a.speed > (length(battle, a) - a.progress) * closingSpeed || gap * b.speed > (length(battle, b) - b.progress) * closingSpeed) continue;
      events.push({ kind: "intercept", a: a.id, b: b.id, numerator: gap, denominator: closingSpeed, key });
    }
  }
  events.sort((a, b) => a.numerator * b.denominator - b.numerator * a.denominator ||
    (a.kind === b.kind ? 0 : a.kind === "intercept" ? -1 : 1) || ordered(a.key, b.key));
  for (const event of events) {
    if (event.kind === "impact") {
      const flight = battle.flights[event.id];
      if (flight) impact(battle, flight, damage);
    } else {
      const a = battle.flights[event.a], b = battle.flights[event.b];
      if (!a || !b) continue;
      a.durability--; b.durability--;
      seen.add(event.key);
      battle.lastCombatStep.events.push({ kind: "intercept", tick: battle.world.tick, a: a.id, b: b.id });
      if (a.durability === 0) consume(battle, a.id, "intercepted");
      if (b.durability === 0) consume(battle, b.id, "intercepted");
    }
  }
  for (const old of active) {
    const flight = battle.flights[old.id];
    if (!flight) continue;
    flight.progress += flight.speed;
    trySplit(battle, flight);
  }
  battle.interceptedPairs = [...seen].filter(key => (JSON.parse(key) as string[]).every(id => Object.hasOwn(battle.flights, id))).sort(ordered);
  return damage;
}
