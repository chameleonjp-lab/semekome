import assert from 'node:assert/strict';
import test from 'node:test';
import { actorArtFacing, drawDirectionalActorArt, type ActorArtName, type ActorArtFacing } from '../../src/presentation/game-art.ts';
import { castleExitGuide, floorAmmoRenderSize } from '../../src/presentation/battle-renderer.ts';
import { createBattle } from '../../src/simulation/physical-battle.ts';

function drawCalls(role: ActorArtName, facing: ActorArtFacing): string[] {
  const calls: string[] = [];
  const properties: Record<string, unknown> = { globalAlpha: 1 };
  const context = new Proxy(properties, {
    get(target, key) {
      if (key in target) return target[key as string];
      return (...args: unknown[]) => { calls.push(`${String(key)}:${JSON.stringify(args)}`); };
    },
    set(target, key, value) { target[key as string] = value; calls.push(`${String(key)}=${value}`); return true; },
  }) as unknown as CanvasRenderingContext2D;
  drawDirectionalActorArt(context, role, facing, 30, 40, 25);
  return calls;
}

test('four directional views have deterministic diagonal priority and a safe default', () => {
  assert.equal(actorArtFacing({ x: 0, y: -1 }), 'up');
  assert.equal(actorArtFacing({ x: 0, y: 1 }), 'down');
  assert.equal(actorArtFacing({ x: -1, y: 0 }), 'left');
  assert.equal(actorArtFacing({ x: 1, y: 0 }), 'right');
  assert.equal(actorArtFacing({ x: -1, y: 1 }), 'left');
  assert.equal(actorArtFacing({ x: 0, y: 0 }), 'right');
});

test('every role has four distinct upright views even when all asset images are absent', () => {
  for (const role of ['hero', 'helper', 'gunner', 'guard', 'carrier', 'soldier'] as const) {
    const views = (['up', 'down', 'left', 'right'] as const).map((facing) => drawCalls(role, facing));
    assert.equal(new Set(views.map((calls) => calls.join('\n'))).size, 4, `${role} has four distinct views`);
    assert.ok(views.every((calls) => !calls.some((call) => call.startsWith('rotate:'))), 'robots stay upright');
    const eyes = (calls: string[]) => calls.filter((call) => call.startsWith('ellipse:'));
    assert.equal(eyes(views[0]).length, 0, 'rear view has no face');
    assert.equal(eyes(views[1]).length, 2, 'front view has both eyes');
    assert.ok(views[2].includes('scale:[-1,1]'), 'left is mirrored horizontally only');
  }
});

test('floor ammo is conspicuous at phone and desktop zoom without changing physical sizes', () => {
  for (const scale of [7, 11.25, 15]) {
    assert.ok(floorAmmoRenderSize(scale) >= 18);
    assert.ok(floorAmmoRenderSize(scale) >= scale * 1.55);
    assert.ok(floorAmmoRenderSize(scale) > Math.max(9, scale * 0.76) * 1.8);
  }
});

test('castle entrance guides follow adopted player-right enemy-left exits', () => {
  const state = createBattle({ matchId: 'exit-guides', seed: 9 });
  const home = castleExitGuide(state.layout.home);
  const enemy = castleExitGuide(state.layout.enemy);
  assert.equal(home.direction, 1);
  assert.equal(enemy.direction, -1);
  assert.equal(home.point.x + enemy.point.x, state.layout.home.widthCells);
  assert.equal(home.point.y, enemy.point.y);
  assert.ok(home.label.includes('敵陣へ →'));
  assert.ok(enemy.label.startsWith('←'));
});

test('muzzle traces show only current-area visible shooters and expire by simulation tick', async () => {
  const { visibleShotTraces } = await import('../../src/presentation/battle-renderer.ts');
  const state = createBattle({ matchId: 'shot-trace-visibility', seed: 11 });
  state.tick = 20;
  const makeShot = (id: string, actorId: string, area: 'castle' | 'plaza', castleTeam: 'player' | 'enemy' | undefined, firedAtTick = 20) => ({
    id, actorId, team: actorId.startsWith('P') ? 'player' as const : 'enemy' as const,
    area, castleTeam, from: { x: 30000, y: 35000 }, to: { x: 40000, y: 35000 }, firedAtTick,
  });
  const shots = [
    makeShot('visible', 'P1', 'castle', 'player'),
    makeShot('old', 'P1', 'castle', 'player', 8),
    makeShot('future', 'P1', 'castle', 'player', 21),
    makeShot('elsewhere', 'P1', 'plaza', undefined),
    makeShot('hidden-enemy', 'E01', 'castle', 'enemy'),
  ];
  Object.assign(state, { shots });
  const before = JSON.stringify(state);
  assert.deepEqual(visibleShotTraces(state, 'castle', 'player').map((shot) => shot.id), ['visible']);
  assert.deepEqual(visibleShotTraces(state, 'castle', 'enemy'), []);
  assert.equal(JSON.stringify(state), before, 'render projection never changes state');
});
