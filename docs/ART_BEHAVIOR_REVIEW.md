# 生成素材と戦闘状態の独立監査

2026-09-27（日本時間）。対象はPR #34統合後の表示層 `battle-renderer.ts` / `battle-screen.ts`、生成済み22画像、物理 `physical-battle.ts` と第5版資料。以下の一覧は発見時点の問題を残し、末尾の追検表に修正後の状態を記録する。静的監査と単体描画テストは実機試遊を代用しない。

## 再現可能な不整合

1. **高：広場背景に無傷の城と装甲が固定描画される。** `stage.webp` 自体に左右の装甲城、砲台、城門、広場の囲いが焼き込まれている。`drawPlazaMap` はこの一枚を毎フレーム `drawGameArt('stage', 0, top, width, mapHeight, .92)` で画面全体に固定し、実座標で移動する広場・7枚の外装状態を重ねる。カメラを中央から端へ動かしても背景の両城が左右に現れ続け、外装を全破壊しても背景の装甲板は残る。背景の手前の囲いも当たり判定に連動しない。ホームの説明絵としては利用可能だが、戦闘背景には城と障害物を描き込まない地形素材が必要。`public/assets/generated/stage.webp` と `src/presentation/battle-renderer.ts` の広場描画を参照。
2. **高：1フレーム内の複数固定更新で演出イベントが消える。** `battle-screen.ts` のRAFループは `step.ticks` 回 `stepBattle` を呼んだ後、最終状態だけを `render` へ渡す。`recordEffects` は `state.lastStep.events` のみ読む。したがって2更新以上進むフレームでは最終更新より前の `actor_died`、`part_destroyed`、`projectile_intercepted` 等を拾えない。30fpsなら60Hzゲームの2更新が通常起こり、状態・HPは進むのに画面上の効果が欠ける。各更新のイベントを描画へ集約するか、イベント履歴をtick境界付きで消費する。
3. **中：人物と設備の絵の大きさが物理接触輪郭を大幅に超える。** `drawPerson` は主人公の絵を2.5セル、他人物を2セル幅、外周輪をそれぞれ半径1.4/1.12セル相当で描く。一方 `ACTOR_RADIUS_SUBUNITS=280`、物理直径は0.56セル。設備は絵約1.15〜1.28セル、物理本体は0.6セル。中心座標は正しいが、見た目の接触・隙間と実際の通行/突進接触が一致しない。試遊可能な接触表示なら絵を縮めるか、実判定半径と視認性輪を明確に分ける。`src/actors/movement.ts` と `src/actors/geometry.ts` を参照。
4. **中：開門と核保護解除が閉鎖状態の絵のまま。** `gate.webp` は中央の錠が付いた閉扉で、開門時も同じ絵を不透明度0.24で通路に残す。`core.webp` は保護枠が付いた核で、7門開放前後に同じ絵を描く。第5版 `SEVEN_PART_CORE_RULES.md` は最後の門開放とコア攻撃可能を無音で伝えるよう求める。ゲームの `gates[id].open` と `openGateIds.length===7` に応じ、通路を空に見せる開門画像/状態記号、保護解除の核表示へ切り替える。
5. **中：城内死亡を広場観戦として表示する。** 物理 `markDeathIfNeeded` は死亡位置と `actor.location.area/castleTeam` を維持し、復活時に担当室へ移す。描画分岐は `!player.alive` だけで広場カメラを選び、下部にも「広場 · … · 復活」と表示する。自城または敵城内でP1が死んだとき、現位置と違う広場が映り、死亡した部屋や敵城内の戦況が見えない。観戦カメラを意図するなら観戦対象・場所を明示し、少なくとも死亡地点を広場と誤表示しない。
6. **中：被弾/破壊演出が目標の外装部位と一致しない。** `recordEffects` は `part_damaged.partId`、`part_destroyed.partId`、`projectile_impacted.targetPart` を演出に保持せず、城内の効果は全て前面壁の中央 `facadeX, y=35` に出す。P1とP7が別々に被弾しても同じ点で光り、個別7部位の破壊箇所が読めない。イベントの部位IDから描画する装甲板の座標を決める。
7. **中：減速領域の実座標・残時間が見えない。** 粘着弾は `slow_zone_created` を発行し、対象城の前部入口を中心とする半径内の人物移動倍率を変える。描画は `supplyStops` の赤輪を補給口に出すが、`state.logistics.slowZones[team]` を読まない。人物は不可視の境界で突然低速化し、効果がいつ切れたかも分からない。入口座標と半径、残時間に結びついたエリア効果を描く。
8. **高：侵入先で荷物を置くと不可視・回収不能になる。** 公開操作の再現：`createBattle({matchId:'audit-foreign-drop',seed:13})` を31更新進める。自陣床ケース `case-player-supply_1-g01` の位置へP1を信頼済みテスト配置し、`getInteraction` の `contextToken` と `pickup` で取得する。P1を敵城 `central_corridor` のセル中心へ信頼済み配置すると `getInteraction.handles=['drop']`。同じトークンで `drop` を行うと拒否はなく、対象は床ケースになる。しかし `object.location.team='player'`、`roomId='corridor_3'` と自陣レイアウトへ誤投影し、敵城を描く床ケース条件 `location.team==='enemy'` から消える。直後の `getInteraction.handles=[]` で拾い直せない。`currentTeam`（所有/補給陣営）と実際の城所在を分離するか、侵入先での設置を明確に拒否する必要がある。通常の出撃場所から敵城への移動を短縮する信頼済みテスト配置以外は公開 `pickup` / `drop` を使った。
9. **中：分裂弾の子3発が一発に重なって見える。** 物理は親を消費し、子3発を2経路単位ずつ離して作る。飛翔帯約274pxでは直通120単位で子同士約4.6px、迂回156単位で約3.5px。一方 `drawFlightLanes` は親・子に同じ15pxの `split_payload` 画像を同じ高さで描く。子が相互に重なったまま別々に迎撃・各4損傷となり、画面の見た目と効果数が合わない。子の `parentObjectId` / flight IDを見て大きさと高さを分け、3発の輪郭を見せる。
10. **中：城内ミニマップに未発見の敵と死亡印が出る。** 発見時の `drawCastleMap` は現在の城にいる敵人物を全員 `relevantActors` に含め、俯瞰ミニマップにも生存位置を全数描く。未訪問室にいる敵まで位置を特定でき、死亡した敵の半透明画像はその死亡を観測していなくても示される。第5版 `PRODUCT_REQUIREMENTS.md` §11.1 は未発見室の敵位置を無条件公開せず、観測した討伐の復活印を示すと定める。現視点の同室・床視線で敵を絞り、実際に観測した死亡世代だけを復活印へ反映する必要がある。味方位置や広場で公開される人物を削除しない。

### 8 の再現状態と修正判定

`seed:13`、`matchId:'audit-foreign-drop'` で `createBattle` 後に31回 `stepBattle` を呼ぶと `case-player-supply_1-g01` が自陣の床に生成される。P1 の `fixedActors.P1.position` と `actors.P1.position` をそのケースの `position` に合わせる信頼済みテスト配置を一度行い、公開 `getInteraction(state,'P1',0).contextToken` を添えて `handle:'pickup', slot:0` を `stepBattle` へ渡す。次にテスト配置で P1 の `location={area:'castle',castleTeam:'enemy'}`、`currentRoomId='central_corridor'`、固定座標 `{x:31500,y:35500}`、整数座標 `{x:31,y:35}` に変更し、新しい `contextToken` と `handle:'drop',slot:0` を公開 `stepBattle` に渡す。修正前は `drop` の拒否が空でも `objects[caseId].location.team==='player'`、敵城でのケース表示・回収候補が消えた。修正判定は、拒否なしの drop で `battleCases[caseId].floorLocation={area:'castle',castleTeam:'enemy'}` と `objects[caseId].location.team==='enemy'`、同じ地点の `getInteraction` に `pickup` が入り、再取得できること。`sourceTeam`、`originGroupId` および補給の持ち主を表す `currentTeam` は player に保たれること。敵城外装や所属・設備権限まで enemy に移さない。信頼済み配置は経路移動の時間を省くためだけに用い、pickup/drop は公開の操作検証を通す。

**修正確認済み（8）：** 上記 seed と公開操作を再実行し、敵城に drop したケースの床所属が enemy、部屋が `central_corridor`、直後の `getInteraction.handles` に `pickup` があることを確認。元の `sourceTeam`、`currentTeam`、`originGroupId` と補給口の `groupCount=1`、グループの `retired=false` は維持された。さらに `tests/rules/cross-area-cargo.test.ts` の5件が通過し、敵兵による敵城床ケースの取得、奪取ケースを自砲台から撃つ権限、広場床と城内の場所境界、被弾・死亡時のケース落下位置と `object_moved.location` の一致、敵砲台の受渡し枠で奪ったケースが元の枠登録を解除することを検査している。共通配送も `sourceTeam` でなく床の `location.team` と `area` を使って候補を選び、`tests/rules/cargo-common-floor.test.ts` は異城の同名部屋からの持込を拒み、地元床の奪取ケースを許す。計6件の追加テストが通過した。

## 照合済みの不変条件

`createBattle({seed:1})` の実状態で、自陣人物3人・敵30人、両城それぞれ外装7部位・門7枚・砲台4基・補給口4か所、`frontDirection` は自陣+1/敵陣−1。敵の配置プレビューは実レイアウトの反転済み座標を読み、敵砲台画像だけ向きを反転する。人物ID・城所属・数字/文字を幾何反転で作り直していない。上記問題は主に表示と状態の結合にあり、人数や門を減らす理由にはならない。

画像キャッシュは表示ごとに画像オブジェクトを再生成せず、各試合の `createBattleRenderer` は独立した効果リストを作る。停止中に同じ `lastStep` を再描画しても `lastObservedTick` とイベントキーが重複を防ぐ。`getGameArt` は画像失敗を `null` として永続記憶するため、接続回復後も同じページ内では再試行しないが、欠損時の図形代替は機能する。これは回復性の限定点であり、上のゲーム状態不整合とは分ける。

## 修正差分の独立追検

| 上記番号 | 追検状態 | 具体的な確認 |
| --- | --- | --- |
| 1 | 静的修正確認 | `stage-v2.webp` はホーム装飾に使用。実戦の `drawPlazaMap` から固定全面 `stage` 描画を除き、カメラ座標に追随する物理広場タイルと状態連動の左右2城だけを描く。実画面の端から端までの巡回は別途ブラウザ確認が必要。 |
| 2 | 単体描画テスト通過 | `battle-screen` は固定更新の毎tickで `render.observeStep(state)`。tick＋イベント添字で同一更新の複数イベントを区別し、飛翔の前状態も毎tick更新。`battle-renderer.test.ts` は最初の更新の被弾座標を保存して次の更新後一度だけ描画し、最初の位置へ光が残ることを確認。一時停止中の同tick再描画も同じ演出数。実機での連続フレーム観察は別途確認対象。 |
| 3 | 静的修正確認 | 人物の中心円は `ACTOR_RADIUS_SUBUNITS/FLOOR_SUBUNITS*scale` と実半径に一致。設備の点線四角も0.6セル幅。立ち絵の読みやすさを保つ装飾は判定輪から区別した。 |
| 4 | 静的修正確認 | 開いた門の錠付き画像を通路から除き、閉門は実通路セルに横線。コアは7門開放時のみ「攻撃可能」、それ以前は「保護中 x/7」、命中後は「核損傷」を表示。 |
| 5 | 静的修正確認 | 戦死中は広場を観戦画面として描き、城内死亡も「観戦 · 自城/敵城で撃破 · 復活まで…」と示す。HUD/Canvas説明にも死亡時の元所在地と観戦状況を反映。死亡地点から広場へのカメラ変更は画面上に明示。 |
| 6 | 静的修正確認 | イベント処理時に P1～P7 の部位IDと開放門IDを個別アンカーへ固定。城内外とも同じ部位の図形位置へ演出を出す。0損傷の防護板命中は破壊光ではなく青い輪。 |
| 7 | 静的修正確認 | `state.logistics.slowZones[team]` の中心・物理半径・倍率・期限から、対象城の入口へ減速円と残り時間を描く。供給停止の輪とは別状態。 |
| 8 | 公開操作と自動テストで修正確認 | 上の再現、補給起源/所有権、敵兵奪取、広場床、死亡・接触落下、イベントの現在位置一致、共通配送の所在境界。詳細は「8 の再現状態と修正判定」。 |
| 9 | 静的修正確認 | 分裂子だけ `parentObjectId` を参照し、親の三連画像ではなく直径2.6pxの単体輪郭へ切り替える。直通/迂回の子間距離約4.6/3.5pxと比べて輪郭を識別できる。 |
| 10 | 静的・単体テストで修正確認 | `actorVisibleToPlayer` は城所属と同室に加え、閉門や壁を含む床視線を要求する。城内人物と同じ `relevantActors` 集合を俯瞰ミニマップにも渡す。敵の死亡演出はその更新で見えていた場合だけ採用し、`id:generation` の観測記録を復活印に使い、復活または世代変更で消す。味方位置は維持し、広場で生存する人物は広場観戦に残る。投影テストは異室・異城の同名室・閉門・味方・広場観戦を検査した。 |

床ケースの初回描画差分に `floorCaseAnchor` のセル座標をもう一度1000で割る誤りがあり、独立レビューで検出して城内・広場とも修正済み。公開拾得位置と描画座標の変換は `tests/presentation/battle-projection.test.ts` でも検査。資料に記した人数33人、外装7部位、門7枚、設備各4基の状態権威はそのまま維持する。
