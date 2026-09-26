import { PART_IDS } from '../domain/types.ts';
import type { ActorState, PartId, TeamId } from '../domain/types.ts';
import type { BattleState } from '../simulation/physical-battle.ts';

export type HudAction = 'pickup' | 'drop' | 'deliver' | 'load' | 'repair' | 'launch' | 'intercept' | undefined;

export function partDisplayName(partId: PartId): string {
  return `外装${PART_IDS.indexOf(partId) + 1}`;
}

function castleTeam(actor: ActorState): TeamId {
  return actor.location.area === 'castle' ? actor.location.castleTeam ?? actor.team : actor.team;
}

function castleRoomName(state: BattleState, actor: ActorState): string {
  const team = castleTeam(actor);
  const layout = team === 'player' ? state.layout.home : state.layout.enemy;
  return layout.rooms.find((room) => room.id === actor.currentRoomId)?.label ?? '通路';
}

export function actorLocationName(state: BattleState, actor: ActorState): string {
  if (actor.location.area === 'plaza') return '広場';
  return `${castleTeam(actor) === 'player' ? '自陣' : '敵陣'} · ${castleRoomName(state, actor)}`;
}

function remainingClock(state: BattleState, actor: ActorState): string {
  const ticks = Math.max(0, (actor.respawnAtTick ?? state.tick) - state.tick);
  const seconds = Math.ceil(ticks / state.rules.ticksPerSecond);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function actorStatusName(state: BattleState, actor: ActorState): string {
  const location = actorLocationName(state, actor);
  if (actor.alive) return location;
  const origin = actor.location.area === 'plaza' ? '広場' : `${castleTeam(actor) === 'player' ? '自陣' : '敵陣'} · ${castleRoomName(state, actor)}`;
  return `観戦 · ${origin}で撃破 · 復活まで ${remainingClock(state, actor)}`;
}

export function battleMapLabel(state: BattleState, actor: ActorState): string {
  if (!actor.alive) return `観戦中。死亡地点：${actorLocationName(state, actor)}。広場と両城の外観、上空の砲撃を表示しています。`;
  const location = actorLocationName(state, actor);
  return actor.location.area === 'plaza'
    ? `広場と両城の外観、直通・迂回の砲撃経路を表示しています。`
    : `${location}の城内図と直通・迂回の砲撃経路を表示しています。`;
}

export function battleHint(state: BattleState, actor: ActorState, available: HudAction, hasCargo: boolean, canDrop: boolean): string {
  if (!actor.alive) {
    const battleStatus = state.phase === 'paused' || state.visibility !== 'visible'
      ? '一時停止中のため戦況も止まっています。'
      : state.phase === 'ended' ? '戦闘は終了しています。' : '広場と両城の戦況は進行しています。';
    return `観戦中です。${actorLocationName(state, actor)}で倒れました。${battleStatus}復活まで ${remainingClock(state, actor)}。`;
  }

  if (available === 'pickup') return `${actorLocationName(state, actor)}です。近くの床の弾を選択中の所持枠へ拾えます。`;

  if (actor.location.area === 'plaza') {
    const cargoHint = canDrop && hasCargo ? '選択中の弾を広場に置けます。' : hasCargo ? '選択中の弾を運んでいます。' : '床の弾を拾ったり置いたりできます。';
    return `広場です。${cargoHint}敵城へは広場警備を突破すると進めます。主人公の近接攻撃操作はこの画面にありません。`;
  }

  const homeCastle = actor.location.castleTeam === actor.team;
  if (!homeCastle) {
    if (canDrop && hasCargo) return `敵陣 · ${castleRoomName(state, actor)}です。ここで選択中の弾を置けます。砲台操作と修理は自陣で行います。`;
    if (hasCargo) return `敵陣 · ${castleRoomName(state, actor)}です。運搬中の弾を自陣へ持ち帰れます。砲台操作と修理は自陣で行います。`;
    return `敵陣 · ${castleRoomName(state, actor)}です。床の弾はここでも拾えます。砲台操作と修理は自陣で行います。`;
  }

  if (available === 'repair') return '修理室です。所持中の弾を1個使い、損傷した外装または設備を修理できます。';
  if (available === 'load') return '砲台の操作位置です。装填後もここで待つと自動発射します。';
  if (available === 'deliver') return '選択中の弾を砲台の受け渡し枠へ渡せます。';
  if (hasCargo) return '選んだ弾を砲台へ運び、受け渡し枠へ渡すか装填します。';
  if (actor.currentRoomId === 'repair') return '修理室です。損傷した外装や設備の修理には弾を1個使います。';
  if (actor.currentRoomId === 'central_corridor') return '中央通路です。自陣の弾薬庫でケースを拾い、隣の砲台へ運びます。広場へ移動できますが、主人公の近接攻撃操作はこの画面にありません。';
  if (actor.currentRoomId === 'core') return '核室です。勝敗条件に関わる場所ですが、この画面からは核攻撃を操作できません。';
  if (state.layout.home.rooms.some((room) => room.id === actor.currentRoomId && room.kind === 'supply')) {
    return '弾薬庫です。床のケースに近づき、選択中の所持枠へ拾って隣の砲台へ運びます。';
  }
  if (state.layout.home.rooms.some((room) => room.id === actor.currentRoomId && room.kind === 'battery')) {
    return '砲撃室です。床のケースを砲台近くまで運び、砲台へ渡すか装填します。';
  }
  return '床の弾に近づいて拾い、砲台へ運びます。砲台の操作位置で待つと自動発射します。';
}
