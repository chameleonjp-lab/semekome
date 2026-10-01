import assert from "node:assert/strict";
import test from "node:test";
import { createAllyCommandQueue } from "../../src/presentation/ally-command-queue.ts";
import { createBattle, stepBattle } from "../../src/simulation/physical-battle.ts";
import type { AllyActorId, AllyCommand, BattleState } from "../../src/simulation/physical-battle.ts";

type AllyCommandQueue = ReturnType<typeof createAllyCommandQueue>;

function fixture(matchId = "ally-command-queue"): BattleState {
  return createBattle({ matchId, seed: 20260913 });
}

function applyNext(state: BattleState, queue: AllyCommandQueue): BattleState {
  const allyCommand = queue.take(state);
  return stepBattle(state, {
    matchId: state.matchId,
    actorId: "P1",
    generation: state.actors.P1.generation,
    direction: { x: 0, y: 0 },
    ...(allyCommand ? { allyCommand } : {}),
  });
}

function queueBoth(state: BattleState): AllyCommandQueue {
  const queue = createAllyCommandQueue();
  queue.toggle(state, "P3");
  queue.toggle(state, "P2");
  return queue;
}

// Every read must remove invalid entries, including a read for the other ally.
const readers = [
  {
    name: "peek",
    read(queue: AllyCommandQueue, state: BattleState): readonly AllyCommand[] {
      return (["P2", "P3"] as const).flatMap((allyId) => {
        const kind = queue.peek(state, allyId);
        return kind ? [{ allyId, kind }] : [];
      });
    },
  },
  {
    name: "take",
    read(queue: AllyCommandQueue, state: BattleState): readonly AllyCommand[] {
      const command = queue.take(state);
      return command ? [command] : [];
    },
  },
  {
    name: "snapshot",
    read(queue: AllyCommandQueue, state: BattleState): readonly AllyCommand[] {
      return queue.snapshot(state);
    },
  },
] as const;

test("P2/P3 clicks before the next tick are kept independently and applied once in P2/P3 order", () => {
  let state = fixture();
  const queue = queueBoth(state);
  assert.deepEqual(queue.snapshot(state), [
    { allyId: "P2", kind: "hold" },
    { allyId: "P3", kind: "hold" },
  ]);
  assert.equal(state.tick, 0);
  assert.deepEqual(state.allyOrders, { P2: null, P3: null }, "queuing does not change simulation state");

  state = applyNext(state, queue);
  assert.deepEqual(state.lastStep.acceptedInputKinds.filter((kind) => kind.startsWith("ally:")), ["ally:hold:P2"]);
  assert.equal(state.allyOrders.P2?.generation, state.actors.P2.generation);
  assert.equal(state.allyOrders.P3, null);
  assert.equal(queue.peek(state, "P2"), undefined);
  assert.equal(queue.peek(state, "P3"), "hold");

  state = applyNext(state, queue);
  assert.deepEqual(state.lastStep.acceptedInputKinds.filter((kind) => kind.startsWith("ally:")), ["ally:hold:P3"]);
  assert.equal(state.allyOrders.P3?.generation, state.actors.P3.generation);
  assert.deepEqual(queue.snapshot(state), []);

  state = applyNext(state, queue);
  assert.deepEqual(state.lastStep.acceptedInputKinds.filter((kind) => kind.startsWith("ally:")), []);
  assert.equal(queue.take(state), undefined, "consumed commands cannot be sent a second time");
});

test("two toggles cancel only that ally's unsent hold and do not send a redundant supply order", () => {
  let state = fixture();
  const queue = queueBoth(state);
  queue.toggle(state, "P2");
  assert.equal(queue.peek(state, "P2"), undefined);
  assert.equal(queue.peek(state, "P3"), "hold");
  state = applyNext(state, queue);
  assert.deepEqual(state.lastStep.acceptedInputKinds.filter((kind) => kind.startsWith("ally:")), ["ally:hold:P3"]);
  assert.equal(state.allyOrders.P2, null);
  assert.equal(queue.take(state), undefined);
});

test("a held ally toggles to supply and a second unsent toggle cancels without disturbing the other ally", () => {
  let state = fixture();
  const queue = createAllyCommandQueue();
  queue.toggle(state, "P2");
  state = applyNext(state, queue);
  queue.toggle(state, "P3");
  queue.toggle(state, "P2");
  assert.equal(queue.peek(state, "P2"), "supply");
  queue.toggle(state, "P2");
  assert.equal(queue.peek(state, "P2"), undefined);
  assert.equal(queue.peek(state, "P3"), "hold");
  state = applyNext(state, queue);
  assert.equal(state.allyOrders.P2?.kind, "hold");
  assert.deepEqual(state.lastStep.acceptedInputKinds.filter((kind) => kind.startsWith("ally:")), ["ally:hold:P3"]);

  queue.toggle(state, "P2");
  state = applyNext(state, queue);
  assert.equal(state.allyOrders.P2, null);
  assert.deepEqual(state.lastStep.acceptedInputKinds.filter((kind) => kind.startsWith("ally:")), ["ally:supply:P2"]);
});

test("a hold from an earlier ally generation is treated as supply when toggling", () => {
  const state = fixture();
  const queue = createAllyCommandQueue();
  for (const allyId of ["P2", "P3"] as const) {
    state.allyOrders[allyId] = { kind: "hold", generation: state.actors[allyId].generation - 1, issuedAtTick: state.tick };
    queue.toggle(state, allyId);
    assert.equal(queue.peek(state, allyId), "hold");
  }
  assert.equal(queue.snapshot(state).length, 2);
});

test("clear cancels both targets completely and allows fresh commands", () => {
  const state = fixture();
  const queue = queueBoth(state);
  queue.clear();
  assert.deepEqual(queue.snapshot(state), []);
  assert.equal(queue.peek(state, "P2"), undefined);
  assert.equal(queue.peek(state, "P3"), undefined);
  assert.equal(queue.take(state), undefined);
  queue.toggle(state, "P3");
  assert.deepEqual(queue.take(state), { allyId: "P3", kind: "hold" });
});

const globalInvalidations: Array<{ name: string; invalidate(state: BattleState): void }> = [
  { name: "another match", invalidate(state) { state.matchId += "-new"; } },
  { name: "P1 death", invalidate(state) { state.actors.P1.alive = false; } },
  { name: "P1 generation change", invalidate(state) { state.actors.P1.generation += 1; } },
  { name: "pause", invalidate(state) { state.phase = "paused"; } },
  { name: "hidden visibility", invalidate(state) { state.visibility = "hidden"; } },
  { name: "ended battle", invalidate(state) { state.phase = "ended"; } },
];

for (const invalidation of globalInvalidations) {
  test(`${invalidation.name} cancels both pending commands on every read`, () => {
    for (const reader of readers) {
      const original = fixture();
      const queue = queueBoth(original);
      const invalid = structuredClone(original);
      invalidation.invalidate(invalid);
      assert.deepEqual(reader.read(queue, invalid), [], reader.name);
      assert.deepEqual(queue.snapshot(original), [], `${reader.name} removes rather than hides the old commands`);
    }
  });
}

for (const allyId of ["P2", "P3"] as const) {
  for (const invalidation of ["death", "generation change"] as const) {
    test(`${allyId} ${invalidation} cancels only its own command on every read`, () => {
      const otherId: AllyActorId = allyId === "P2" ? "P3" : "P2";
      for (const reader of readers) {
        const original = fixture();
        const queue = queueBoth(original);
        const invalid = structuredClone(original);
        if (invalidation === "death") invalid.actors[allyId].alive = false;
        else invalid.actors[allyId].generation += 1;
        assert.deepEqual(reader.read(queue, invalid), [{ allyId: otherId, kind: "hold" }], reader.name);
        assert.equal(queue.peek(original, allyId), undefined, `${reader.name} cannot revive the invalid target`);
      }
    });
  }
}

test("toggle prunes stale commands before queuing for a new match or life", () => {
  const original = fixture();
  const queue = queueBoth(original);
  const nextMatch = fixture("ally-command-queue-new");
  queue.toggle(nextMatch, "P3");
  assert.deepEqual(queue.snapshot(nextMatch), [{ allyId: "P3", kind: "hold" }]);
  nextMatch.actors.P1.generation += 1;
  queue.toggle(nextMatch, "P2");
  assert.deepEqual(queue.snapshot(nextMatch), [{ allyId: "P2", kind: "hold" }]);
  nextMatch.actors.P2.generation += 1;
  queue.toggle(nextMatch, "P2");
  assert.equal(queue.peek(nextMatch, "P2"), "hold", "a fresh life starts from supply, not the discarded pending hold");
});

test("toggle cannot queue commands while stopped or when P1 or the target is defeated", () => {
  for (const invalidation of globalInvalidations.filter((entry) => entry.name !== "another match" && entry.name !== "P1 generation change")) {
    const state = fixture();
    const queue = queueBoth(state);
    invalidation.invalidate(state);
    queue.toggle(state, "P2");
    state.phase = "running";
    state.visibility = "visible";
    state.actors.P1.alive = true;
    assert.deepEqual(queue.snapshot(state), [], invalidation.name);
  }
  const state = fixture();
  state.actors.P2.alive = false;
  const queue = createAllyCommandQueue();
  queue.toggle(state, "P2");
  queue.toggle(state, "P3");
  state.actors.P2.alive = true;
  assert.deepEqual(queue.snapshot(state), [{ allyId: "P3", kind: "hold" }]);
});

test("snapshot and take return detached commands that cannot alter pending entries", () => {
  const state = fixture();
  const queue = queueBoth(state);
  const snapshot = queue.snapshot(state) as AllyCommand[];
  snapshot[0].allyId = "P3";
  snapshot[0].kind = "supply";
  snapshot[1].kind = "supply";
  snapshot.length = 0;
  assert.deepEqual(queue.snapshot(state), [{ allyId: "P2", kind: "hold" }, { allyId: "P3", kind: "hold" }]);

  const taken = queue.take(state)!;
  taken.allyId = "P3";
  taken.kind = "supply";
  assert.equal(queue.peek(state, "P2"), undefined);
  assert.equal(queue.peek(state, "P3"), "hold");
  assert.deepEqual(queue.take(state), { allyId: "P3", kind: "hold" });
});

for (const actorId of ["P1", "P2"] as const) {
  test(`${actorId} real death and respawn invalidate an unread command from the previous life`, { timeout: 60_000 }, () => {
    let state = fixture(`ally-command-queue-respawn-${actorId}`);
    const queue = queueBoth(state);
    const generation = state.actors[actorId].generation;
    // Boundary fixture: the real coordinator performs death, scheduling,
    // elapsed battle ticks, respawn, and generation change. No death/respawn
    // state or events are injected directly into the queue's snapshots.
    state.actors[actorId].health = 0;
    state = stepBattle(state);
    assert.equal(state.actors[actorId].alive, false);
    assert.equal(state.lastStep.events.filter((event) => event.type === "actor_died" && event.actorId === actorId).length, 1);
    const respawnAtTick = state.actors[actorId].respawnAtTick!;
    while (state.tick < respawnAtTick) state = stepBattle(state);
    // state.tick names the next update; process the scheduled update itself.
    assert.equal(state.actors[actorId].alive, false);
    state = stepBattle(state);
    assert.equal(state.actors[actorId].alive, true);
    assert.equal(state.actors[actorId].generation, generation + 1);
    assert.equal(state.lastStep.events.filter((event) => event.type === "actor_respawned" && event.actorId === actorId && event.tick === respawnAtTick).length, 1);

    assert.deepEqual(queue.snapshot(state), actorId === "P1" ? [] : [{ allyId: "P3", kind: "hold" }]);
    queue.clear();
    queue.toggle(state, "P2");
    assert.deepEqual(queue.snapshot(state), [{ allyId: "P2", kind: "hold" }], "spawn protection does not change the existing alive-only order eligibility");
    state = applyNext(state, queue);
    assert.ok(state.lastStep.acceptedInputKinds.includes("ally:hold:P2"));
    assert.equal(state.allyOrders.P2?.generation, state.actors.P2.generation);
  });
}
