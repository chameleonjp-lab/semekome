import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createBattle, stepBattle } from '../src/simulation/physical-battle.ts';
import { createStandardPlayerDriver } from '../tests/scenarios/standard-player-driver.ts';
const start = Number(process.argv[2] ?? 0), count = Number(process.argv[3] ?? 20);
if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1 || start + count > 20) throw new Error('Invalid balance range');
const results = [];
for (let index = start; index < start + count; index++) {
  const strategy = ['standard-invasion','artillery','support-invasion','room-defense'][index % 4];
  const seed = 20261001 + index;
  let state = createBattle({ matchId: `release-baseline-${index}`, seed });
  const driver = createStandardPlayerDriver(strategy === 'artillery' ? Number.POSITIVE_INFINITY : 4);
  const started = performance.now();
  let launches = 0, repairs = 0, respawns = 0, lastProgressTick = 0, lastGateCount = 0;
  const samples = [];
  while (state.phase === 'running') {
    const intent = driver(state);
    if (intent && state.tick === 1500 && strategy === 'support-invasion') intent.allyCommand = { allyId: 'P2', kind: 'invasion', targetRoomId: 'core' };
    if (intent && state.tick === 1500 && strategy === 'room-defense') intent.allyCommand = { allyId: 'P2', kind: 'defense', targetRoomId: 'repair' };
    const before = performance.now();
    state = stepBattle(state, intent);
    if (state.tick % 10 === 0) samples.push(performance.now() - before);
    for (const event of state.lastStep.events) {
      if (event.type === 'projectile_launched') launches++;
      if (event.type === 'repair_completed' || event.type === 'equipment_repair_completed') repairs++;
      if (event.type === 'actor_respawned') respawns++;
    }
    const gates = state.castles.enemy.openGateIds.length;
    if (gates !== lastGateCount) { lastGateCount = gates; lastProgressTick = state.tick; }
    if (state.tick > state.matchLimitTicks) throw new Error('Clock exceeded match limit');
  }
  if (Object.values(state.actors).filter(actor => actor.team === 'enemy').length !== 30 || state.rules.enemyRespawnTicks !== 1200 || Object.values(state.allyOrders).some(Boolean) || stepBattle(state).tick !== state.tick) throw new Error('Terminal invariant failed');
  samples.sort((a,b) => a-b);
  const record = { index, seed, strategy, outcome: state.outcome, ticks:state.tick, enemyGates:state.castles.enemy.openGateIds.length, playerGates:state.castles.player.openGateIds.length, playerDeaths:state.actors.P1.deathCount, launches, repairs, respawns, lastProgressTick, elapsedMs: Math.round(performance.now()-started), simulationStepP95Ms:Number(samples[Math.floor(samples.length*0.95)]?.toFixed(3)) };
  results.push(record); console.log(JSON.stringify(record));
}
writeFileSync(`/tmp/semekome-balance-${start}.json`, JSON.stringify(results,null,2));
