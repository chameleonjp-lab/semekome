# 工程4：接続準備と必要な判断

## 実サービスで確認した事実

Supabase project `mlpnjgezrnhdxsxolyzj`（chameleonJP-Lab、稼働中）を読取専用で確認した。`public.games`はgame_slugが識別子でありgame_id列はない。`game_slug LIKE 'semekome%' OR game_url LIKE '%/semekome/%' OR title = 'セメコメ'`に一致する登録は0件だった。別名での登録がないという断定には使わない。

現行受付は次の実在と引数・戻り値・anon EXECUTE権限を確認した。

- start_game_play_v1(start_id uuid, display_name text, game_slug text, client_version text) → jsonb
- finish_game_play_v1(play_id uuid, display_name text, game_slug text, result_type text, reached_wave integer, score integer, client_version text, ranking_score integer default null) → jsonb
- submit_score_idempotent_v1(play_id uuid, submission_id uuid, display_name text, game_slug text, score integer, client_version text) → 受付・番号・名前・初回/最高得点・回数等の1行
- get_game_ranking(game_slug text, limit integer default 100) → rank_no、display_name、best_score、play_count、best_score_at

登録/権限/既存記録を変更していない。受付3関数はsecurity definer、空search_path。順位取得はpublic search_path。共有側2026-09-28契約は開始のみを仮retireとして扱い、正常な終了で同じplay_idを確定できる。

## 準備したコード

ranking-clientは8秒打切りの共通REST処理、開始番号の保存と再送、サーバー発行play_idの保持、確定結果とsubmission_idの保存、finish→submitの順序、応答の番号/名前/得点照合、上位10件と返却順位を実装する。未送信を上書きする新規競技開始を拒否し、破損した保留記録も消さない。通信断・応答消失・再読込・同時再送・競合・恒久拒否をstub契約で確認した。これは実DBへの登録試験の代わりではない。

得点は`score-proposal.ts`に提案として隔離した。承認済みmanifestと公開用接続設定がそろった場合だけ、通常結果への適用・送信を有効にする。現在のmanifestでは外部送信は無効。上位表示は読込/空/失敗/成功を分け、同率rank_noをそのまま表示する。共有文は確定得点と指定されたHTTPS正式URLを要求する。未確定のURLを組み立てない。

ルートのranking-manifest.jsonは承認待ちと明記し、正式値をnull/空に保つ。製品へ有効化する前に共通manifestスキーマへ適合する確定値で置換する。現段階のファイルを公開用確定manifestとは扱わない。

## 判断待ちの具体案

得点：勝利基礎100000 + max(0, 敵外装破壊数×1000 + 一度以上倒した敵人数×20 + 勝利時残り整数秒×10 − P1死亡数×100)。敗北/引分は時間加点なし。中止/練習は得点送信なし。理論上限111800、非勝利7600。

競技対象：標準敵作戦・標準難易度・標準補給・運搬型2人を代表ランキングとし、自由編成/他設定/練習は対象外とする提案。開始/終了は全通常戦を計数し、ランキング送信だけを競技条件へ限定する。練習は開始/終了/得点のいずれにも含めない。

対応案：勝利=clear、敗北/引分=game_over、中止=retire、reached_wave=開門数0〜7。画面側はこの対応案で実装し、製品で有効化する前に確認する。正式game_id/game_slug/client_version、公開先と正式URL、実験場の表示順・公開日・説明・共有文は未確定。

## 承認後の手順

1. 確定した得点と競技条件をSCORE_PLAN・本文・実装・受付上限へ同時反映する。
2. 正式URL/識別子と現行gamesの列に合わせて登録SQLをレビューし、非公開登録から始める。公開用キーのみ配布物へ使う。
3. 実RPCで開始・終局・同一番号再送・応答消失・読込0/同率/失敗を照合し、テスト利用者と本番を区別する。
4. 実装済みの自動送信・再送・上位10位・共有/コピー・実験場リンクを確定manifestで有効化し、未送信時の対象外再戦を維持する。
5. 正式URLの実機受入と最後の有効化を公開手順へ残す。main取り込み/配備はこの作業で行わない。

## ブラウザ完走の未達

通常の画面入力を経由する長時間テストでは全7門の開通を確認したが、勝利完走は未達。敵城内の戦闘で死亡を繰り返すため、操作戦略と実機の難易度評価を継続する必要がある。Nodeの3種子勝利をブラウザ完走や初心者受入の代用とはしない。20戦baselineは追加調整前の記録であり最終候補の合格証拠ではない。
