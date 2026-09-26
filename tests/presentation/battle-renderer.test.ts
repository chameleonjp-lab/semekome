import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattle } from '../../src/simulation/physical-battle.ts';
import { createBattleRenderer } from '../../src/presentation/battle-renderer.ts';
import type { BattleState } from '../../src/simulation/physical-battle.ts';

function canvasHarness(): { canvas: HTMLCanvasElement; calls: Map<string, number>; scales: number[][]; arcs: number[][] } {
  const calls = new Map<string, number>();
  const scales: number[][] = [];
  const arcs: number[][] = [];
  const target: Record<string, unknown> = { globalAlpha: 1, imageSmoothingEnabled: true };
  const context = new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key as string];
      if (typeof key !== 'string') return undefined;
      return (...args: number[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        if (key === 'scale') scales.push(args);
        if (key === 'arc') arcs.push(args);
      };
    },
    set(object, key, value) { object[key as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const createStubCanvas = () => ({ width: 0, height: 0, getContext: () => context });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: (tag: string) => tag === 'canvas' ? createStubCanvas() : null },
  });
  class FailedImage {
    complete = false;
    naturalWidth = 0;
    decoding = 'async';
    onload: ((event: Event) => unknown) | null = null;
    onerror: ((event: Event) => unknown) | null = null;
    set src(_url: string) { queueMicrotask(() => this.onerror?.(new Event('error'))); }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: FailedImage });
  // Every asset request fails asynchronously, like a missing deployed file.
  // The renderer must keep drawing from its shape fallbacks.
  const canvas = {
    clientWidth: 360,
    clientHeight: 180,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, calls, scales, arcs };
}

function snapshot(state: BattleState): string { return JSON.stringify(state); }

test('renderer uses the no-image fallback and does not mutate the battle snapshot', () => {
  const { canvas, calls } = canvasHarness();
  const state = createBattle({ matchId: 'renderer-fallback', seed: 13 });
  const before = snapshot(state);
  const render = createBattleRenderer(canvas, state);

  render(state, 'P1', 0);
  render(state, 'P1', 1);

  assert.equal(snapshot(state), before);
  assert.ok((calls.get('fillRect') ?? 0) > 100, 'floor tiles and shape fallbacks are drawn');
  assert.ok((calls.get('arc') ?? 0) > 0, 'person and gate fallbacks are drawn without loaded images');
  assert.ok((calls.get('drawImage') ?? 0) > 0, 'the cached floor surface is composed into the display');
});

test('renderer selects enemy-castle and plaza projections from actor location', () => {
  const { canvas, calls, scales } = canvasHarness();
  const initial = createBattle({ matchId: 'renderer-areas', seed: 23 });
  const render = createBattleRenderer(canvas, initial);
  const enemyState = structuredClone(initial);
  enemyState.actors.P1.location = { area: 'castle', castleTeam: 'enemy', roomId: 'central_corridor', pathRooms: ['central_corridor'], pathGates: [] };
  enemyState.actors.P1.currentRoomId = 'central_corridor';
  enemyState.fixedActors.P1.position = { x: 95_500, y: 35_500 };
  const plazaState = structuredClone(initial);
  plazaState.actors.P1.location = { area: 'plaza', pathRooms: [], pathGates: [] };
  plazaState.actors.P1.currentRoomId = 'plaza';
  plazaState.fixedActors.P1.position = { x: 63_000, y: 35_000 };

  const beforeEnemy = snapshot(enemyState);
  const beforePlaza = snapshot(plazaState);
  render(enemyState, 'P1');
  const afterEnemyDraws = calls.get('fillRect') ?? 0;
  assert.ok(scales.some(([x, y]) => x === -1 && y === 1), 'enemy-facing turret art is mirrored without turning its lighting upside down');
  render(plazaState, 'P1');

  assert.ok((calls.get('fillRect') ?? 0) > afterEnemyDraws, 'plaza scenery is rendered from the plaza location');
  assert.equal(snapshot(enemyState), beforeEnemy);
  assert.equal(snapshot(plazaState), beforePlaza);
});

test('enemy projectile sprites face left and interception flashes use tracked route positions', () => {
  const { canvas, scales, arcs } = canvasHarness();
  const initial = createBattle({ matchId: 'renderer-flight-direction', seed: 37 });
  initial.artillery.flights = {
    playerFlight: { id: 'playerFlight', objectId: 'caseP', team: 'player', route: 'detour', progress: 0.2 } as BattleState['artillery']['flights'][string],
    enemyFlight: { id: 'enemyFlight', objectId: 'caseE', team: 'enemy', route: 'detour', progress: 0.7 } as BattleState['artillery']['flights'][string],
  };
  initial.battleCases.caseP = { id: 'caseP', type: 'fast_dart' } as BattleState['battleCases'][string];
  initial.battleCases.caseE = { id: 'caseE', type: 'fast_dart' } as BattleState['battleCases'][string];
  const render = createBattleRenderer(canvas, initial);
  render(initial, 'P1');
  assert.ok(scales.some(([x, y]) => x === -1 && y === 1), 'enemy projectile artwork is mirrored horizontally');

  const impact = structuredClone(initial);
  impact.tick = 1;
  impact.artillery.flights = {};
  impact.lastStep = {
    processedTick: 0,
    advanced: true,
    acceptedInputKinds: [],
    rejected: [],
    events: [{ type: 'projectile_intercepted', firstProjectileId: 'playerFlight', secondProjectileId: 'enemyFlight' }],
  };
  render(impact, 'P1');

  const expectedX = 43 + (360 - 86) * 0.25;
  const expectedY = 43.2 * 0.72;
  assert.ok(arcs.some(([x, y, radius]) => Math.abs(x - expectedX) < 0.01 && Math.abs(y - expectedY) < 0.01 && radius >= 7),
    'the impact ring is on the tracked detour lane at the midpoint of the opposing flight positions');
});

test('tick-based hit effects stay fixed when a paused snapshot is rendered repeatedly', () => {
  const { canvas, calls } = canvasHarness();
  const state = createBattle({ matchId: 'renderer-paused-effect', seed: 31 });
  state.phase = 'paused';
  state.pauseReasons = ['explicit'];
  state.lastStep = {
    processedTick: state.tick,
    advanced: true,
    acceptedInputKinds: [],
    rejected: [],
    events: [{ type: 'actor_damaged', actorId: 'P1', amount: 1 }],
  };
  const before = snapshot(state);
  const render = createBattleRenderer(canvas, state);

  render(state, 'P1');
  const firstFrame = calls.get('arc') ?? 0;
  render(state, 'P1');
  const secondFrame = calls.get('arc') ?? 0;

  assert.equal(secondFrame - firstFrame, firstFrame, 'the same stopped tick yields the same number of hit-effect primitives');
  assert.equal(snapshot(state), before);
});
