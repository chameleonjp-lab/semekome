# R2ag 終局結果画面と再戦状態リセット

## 判定範囲

R2af取り込み後のmainを基準に、通常戦の終局を簡易オーバーレイだけで終わらせず、同じ試合状態から正式結果画面へ切り替える。今回の結果画面は、勝敗、勝敗理由、経過時間、敵外装の破壊数、敵門の開放数、主人公の砲撃数を表示する。

得点式は `docs/plans/current/SCORE_PLAN.json` の未承認案を採用しない。共有側の `chameleonjp_lab/catalog/games.json` に `semekome` の登録がなく、`game_id`、`game_slug`、公式ランキングURL、RPC値を確認できないため、ランキング送信・共有・実験場リンクも推測して接続しない。

## 実装

- `src/presentation/battle-screen.ts`
  - `state.phase === 'ended'` の終局状態から結果画面を描画する。
  - プレイヤー名はHTMLへ直接連結せず、結果画面の要素へ `textContent` で設定する。
  - スコアは「得点式の承認待ち」、ランキング・共有は「game_id / game_slug / URL確認待ち」と明示する。
  - 「再戦の準備へ」は現行の物理戦をdisposeして準備画面を再描画する。次の開始は既存試合を再利用せず、新しい `matchId` とtick 0で `createBattle` する。
- `src/presentation/battle.css`
  - 縦長画面でもスクロール可能な結果画面、結果メトリクス、保留中の接続状態を追加する。
- `src/main.ts`
  - ホームの案内を「結果画面まで接続済み」「承認済みスコア・ランキングは未接続」へ更新する。
- `tests/browser/*.spec.ts`
  - 通常初期配置の敵勝利、敵AIの実終局、核勝利fixture、時間切れ・同時命中fixtureを結果画面の属性で検査する。
  - 再戦時の旧試合からの状態持ち越しがないことを `matchId` とtick 0で検査する。

## 保持した境界

- 勝敗判定、コア接触の検証、終局イベント、終局後の世界停止、終局後の入力停止は変更していない。
- 標準配分、外装7部位、7門、敵30人、敵1,200 tick復活、主人公300 tick復活は変更していない。
- 未承認の得点式、ゲーム登録値、ランキングRPC、共有URL、実験場URLを追加していない。

## 検査結果

|検査|結果|
|---|---|
|全Node回帰|302/302通過（`npm test`）|
|資料検査|57/57通過（`npm run check:docs`）|
|型検査・製品ビルド|`npm run build` 通過|
|差分空白|`git diff --check` 通過|
|agent-browser|ローカルdaemonが起動直後に終了し未実施|
|Playwright Chromium|ブラウザー取得元のアーカイブ破損で未実施|
|iPhone実機・試遊|未確認|

CIの手動browser実行で、結果画面の表示、再戦リセット、各終局fixture、終局後の操作停止を再確認する。このPRは正式なスコア、ランキング、公開の完了を意味しない。
