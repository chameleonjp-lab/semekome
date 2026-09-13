# 実装担当への引き継ぎ / 第5版
R2aで8武器の共通砲撃ルール・検証済み操作入口・敵4役割の判断基盤を追加した。次の接続時は ../../RULE_ENGINE.md を全文読み、未実装の連続移動・突進・配送予約・補給生成と区別する。画面は配置確認用のままであり、R2全体の完了ではない。
対象はchameleonjp-lab/semekome。第5版R1の基礎実装と採用配置確認は実装済み。検査の実施範囲は ../../TEST_REPORT.md、次段階は ../../IMPLEMENTATION_PROGRESS.md を参照する。通常戦の完成挙動、実機検査、外部接続・公開登録は未実施である。まずPRODUCT_REQUIREMENTS.md、MAP_ADOPTION.md、SCREEN_FLOW_AND_BATTLEFIELD.md、RESULTS_SCORE_RANKING.md、INITIAL_RULES.json、REQUIREMENTS.json、ENEMY_ROSTER.json、INTERIOR_LAYOUTS.json、ACCEPTANCE_TESTS.jsonを全文読む。核と門の補足はSEVEN_PART_CORE_RULES.md、人物はNPC_ROOMS_AND_RESPAWN.mdを読む。
自陣左で正面右、敵陣右で正面左、中央広場。自陣を90度右回転した採用配置とその左右反転を使う。文字・操作・世界状態を反転共有しない。図にない核と7門を消さず、復活室と分ける。
外装7部位→7門→有効な核一撃、敵30人20秒、広場の敵を倒して前進、相互侵入、主人公5秒観戦復活、名前とカウントダウン、結果のスコア詳細・共有・上位10位・実験場リンクを省かない。外装は城同士の攻撃だけで壊す。
両城の採用図に合わせた4砲台・4弾薬庫・4補給口、敵4/4/8/14、自陣1+2、広場3人・侵入2人、得点式は補足案。自陣4砲台は主人公と補助員2体が運用し、敵の専任射手E01〜E04は敵陣だけで使う。総数を減らして負荷に対応しない。寸法・当たり判定・難易度は未試遊。
ルール番号はsemekome-prototype-0.4-facing-castles。旧第4版と異なる配置と役割を暗黙変換しない。役割・所属・人物番号・生存世代・物体の所在を記録し、画面切替で新しい試合を生成しない。
ランキングは初期公開に必須。ただし接続値は未確定。共有リポジトリの11_ranking_integration_standard.mdを再確認し、同じ開始・結果の再送を一件にする。game_slugや接続処理を名称から推測しない。今回Supabase・公開登録を変更しない。
validate_documents.pyは設計資料だけを検査する。ゲーム検査、実機、試遊、接続確認を合格扱いにしない。mainへ直接push・無断マージ・自動マージ・保護変更・公開はしない。作業ブランチとDraft PRで提出する。
