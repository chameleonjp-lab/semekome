import rules from "../../docs/plans/current/INITIAL_RULES.json" with { type: "json" };
import { FLOOR_SUBUNITS } from "./movement.ts";

/** Intrinsic personal weapon. Carried cases are artillery/repair supplies. */
export const PERSONAL_SHOT_RANGE = rules.actor.personal_shot_range_units * FLOOR_SUBUNITS;
export const PERSONAL_SHOT_COOLDOWN_TICKS = rules.actor.personal_shot_cooldown_ticks;
export const PERSONAL_SHOT_TRACE_TICKS = rules.actor.personal_shot_trace_ticks;
export const PERSONAL_SHOT_EQUIPMENT_DAMAGE = rules.actor.personal_shot_equipment_damage;
export const MOBILITY_DASH_DISTANCE_SUBUNITS = rules.actor.mobility_dash_distance_units * FLOOR_SUBUNITS;
export const PERSONAL_SHOT_DAMAGE = rules.actor.personal_shot_damage;
