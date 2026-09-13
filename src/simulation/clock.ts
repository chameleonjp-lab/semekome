import type { PauseInput, ResumeInput, VisibilityInput, WorldState } from "../domain/types.ts";

export type ClockCommand = PauseInput | ResumeInput | VisibilityInput;

/** Mutates only the clock controls, never advances or catches up time. */
export function applyClockCommand(world: WorldState, input: ClockCommand): void {
  if (input.kind === "pause") {
    if (!world.pauseReasons.includes("explicit")) world.pauseReasons.push("explicit");
  } else if (input.kind === "visibility") {
    world.visibility = input.visible ? "visible" : "hidden";
    if (!input.visible && !world.pauseReasons.includes("visibility")) world.pauseReasons.push("visibility");
    // Showing the page is not consent to resume the battle.
  } else {
    world.pauseReasons = world.visibility === "visible" ? [] : ["visibility"];
  }
  world.phase = world.pauseReasons.length ? "paused" : "running";
}
