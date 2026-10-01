import type {
  AllyActorId,
  AllyCommand,
  AllyCommandKind,
  BattleState,
} from "../simulation/physical-battle.ts";

const ALLY_IDS: readonly AllyActorId[] = ["P2", "P3"];

interface PendingAllyCommand {
  kind: AllyCommandKind;
  command?: AllyCommand;
  matchId: string;
  playerGeneration: number;
  allyGeneration: number;
}

/** Keep at most one unsent order per ally while the simulation takes one per tick. */
export function createAllyCommandQueue() {
  const pending: Partial<Record<AllyActorId, PendingAllyCommand>> = {};

  function clear(): void {
    for (const allyId of ALLY_IDS) delete pending[allyId];
  }

  function prune(state: BattleState): void {
    const player = state.actors.P1;
    if (state.phase !== "running" || state.visibility !== "visible" || !player?.alive) {
      clear();
      return;
    }
    for (const allyId of ALLY_IDS) {
      const command = pending[allyId];
      if (!command) continue;
      const ally = state.actors[allyId];
      if (command.matchId !== state.matchId || command.playerGeneration !== player.generation ||
          !ally?.alive || command.allyGeneration !== ally.generation) {
        delete pending[allyId];
      }
    }
  }

  return {
    submit(state: BattleState, command: AllyCommand): void {
      prune(state);
      const ally = state.actors[command.allyId];
      if (state.phase !== "running" || state.visibility !== "visible" || !state.actors.P1.alive || !ally?.alive) return;
      pending[command.allyId] = { kind: command.kind, command: structuredClone({ ...command, allyGeneration: ally.generation }),
        matchId: state.matchId, playerGeneration: state.actors.P1.generation, allyGeneration: ally.generation };
    },
    toggle(state: BattleState, allyId: AllyActorId): void {
      prune(state);
      const player = state.actors.P1;
      const ally = state.actors[allyId];
      if (state.phase !== "running" || state.visibility !== "visible" || !player?.alive || !ally?.alive) return;

      const order = state.allyOrders[allyId];
      const current: AllyCommandKind = order?.kind === "hold" && order.generation === ally.generation
        ? "hold"
        : "supply";
      const previous = pending[allyId]?.kind ?? current;
      const kind: AllyCommandKind = previous === "hold" ? "supply" : "hold";
      // Returning to the effective order is a cancellation, not a new order
      // that would needlessly reset the ally's current movement assignment.
      if (kind === current) {
        delete pending[allyId];
      } else {
        pending[allyId] = {
          kind,
          matchId: state.matchId,
          playerGeneration: player.generation,
          allyGeneration: ally.generation,
        };
      }
    },

    peek(state: BattleState, allyId: AllyActorId): AllyCommandKind | undefined {
      prune(state);
      return pending[allyId]?.kind;
    },

    take(state: BattleState): AllyCommand | undefined {
      prune(state);
      for (const allyId of ALLY_IDS) {
        const command = pending[allyId];
        if (!command) continue;
        delete pending[allyId];
        return command.command ? structuredClone(command.command) : { allyId, kind: command.kind };
      }
      return undefined;
    },

    snapshot(state: BattleState): readonly AllyCommand[] {
      prune(state);
      return ALLY_IDS.flatMap((allyId) => {
        const command = pending[allyId];
        return command ? [command.command ? structuredClone(command.command) : { allyId, kind: command.kind }] : [];
      });
    },

    clear,
  };
}
