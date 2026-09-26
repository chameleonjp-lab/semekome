import assert from 'node:assert/strict';
import test from 'node:test';
import { createBattle } from '../../src/simulation/battle.ts';
import { prepareCommonDeliveryPlans } from '../../src/simulation/common-delivery.ts';
import { executeActorCommand } from '../../src/simulation/battle-actions.ts';

test('common delivery plans use the physical castle, not the supply source', () => {
  const state = createBattle({ matchId: 'cargo-common-floor', seed: 13 });
  const actor = state.world.actors.E09;
  state.world.objects.case = { id: 'case', weaponId: 'standard_slug', weight: 1, sourceTeam: 'enemy',
    location: { kind: 'floor', team: 'player', roomId: actor.currentRoomId, position: { ...actor.position } } };
  assert.equal(prepareCommonDeliveryPlans(state).length, 0, 'matching room IDs in the opposing castle must not teleport cargo');
  state.world.objects.case.location = { kind: 'floor', area: 'plaza', team: 'enemy', roomId: actor.currentRoomId, position: { ...actor.position } };
  assert.equal(prepareCommonDeliveryPlans(state).length, 0, 'a plaza marker must never count as a castle floor');
  assert.equal(executeActorCommand(state, { kind: 'pickup', matchId: state.world.matchId, actorId: actor.id, generation: actor.generation, objectId: 'case' }), 'out_of_range');
  state.world.objects.case.sourceTeam = 'player';
  state.world.objects.case.location = { kind: 'floor', team: 'enemy', roomId: actor.currentRoomId, position: { ...actor.position } };
  assert.equal(prepareCommonDeliveryPlans(state).length, 1, 'stolen cargo on the local floor remains usable');
  assert.equal(state.world.objects.case.sourceTeam, 'player');
});
