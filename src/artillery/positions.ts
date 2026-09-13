import type { TeamId } from "../domain/types.ts";
import type { FixedPoint } from "../simulation/physical-battle.ts";

export interface TurretPositionSource {
  team: TeamId;
  position: FixedPoint;
}

const FORWARD_OFFSET_SUBUNITS = 650;
const SLOT_OFFSET_SUBUNITS = 350;

function frontSign(team: TeamId): 1 | -1 {
  return team === "player" ? 1 : -1;
}

/**
 * Fixed handoff point for one of a turret's two stable staging slots.
 *
 * `f` is +1 for the player castle and -1 for the enemy castle. Both slots
 * stay in their authored order; slot 0 is the upper (-y) point and slot 1 is
 * the lower (+y) point.
 */
export function getHandoffPosition(
  turret: TurretPositionSource,
  slot: 0 | 1,
): FixedPoint {
  if (slot !== 0 && slot !== 1) throw new RangeError("turret handoff slot must be 0 or 1");
  const f = frontSign(turret.team);
  return {
    x: turret.position.x - FORWARD_OFFSET_SUBUNITS * f,
    y: turret.position.y + (slot === 0 ? -SLOT_OFFSET_SUBUNITS : SLOT_OFFSET_SUBUNITS),
  };
}

/** Fixed operator standing point in front of a turret. */
export function getTurretOperatorPosition(turret: TurretPositionSource): FixedPoint {
  const f = frontSign(turret.team);
  return {
    x: turret.position.x - FORWARD_OFFSET_SUBUNITS * f,
    y: turret.position.y,
  };
}
