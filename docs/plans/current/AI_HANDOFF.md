# 実装担当への引き継ぎ / 第5版
対象はchameleonjp-lab/semekome。今回の変更は設計資料のみ。まずPRODUCT_REQUIREMENTS.md、MAP_ADOPTION.md、SCREEN_FLOW_AND_BATTLEFIELD.md、RESULTS_SCORE_RANKING.md、INITIAL_RULES.json、REQUIREMENTS.json、ENEMY_ROSTER.json、INTERIOR_LAYOUTS.json、ACCEPTANCE_TESTS.jsonを全文読む。核と門の補足はSEVEN_PART_CORE_RULES.md、人物はNPC_ROOMS_AND_RESPAWN.mdを読む。
自陣左で正面右、敵陣右で正面左、中央広場。自陣を90度右回転した採用配置とその左右反転を使う。文字・操作・世界状態を反転共有しない。図にない核と7門を消さず、復活室と分ける。
外装7部位→7門→有効な核一撃、敵30人20秒、広場の敵を倒して前進、相互侵入、主人公5秒観戦復活、名前とカウントダウン、結果のスコア詳細・共有・上位10位・実験場リンクを省かない。外装は城同士の攻撃だけで壊す。
採用図に合わせた4砲台・4庫・4/4/8/14の内訳、自陣1+2、広場3人・侵入2人、得点式は補足案。総数を減らして負荷に対応しない。寸法・当たり判定・難易度は未試遊。
ルール番号はsemekome-prototype-0.4-facing-castles。旧第4版と異なる配置と役割を暗黙変換しない。役割・所属・人物番号・生存世代・物体の所在を記録し、画面切替で新しい試合を生成しない。
ランキングは初期公開に必須。ただし接続値は未確定。共有リポジトリの11_ranking_integration_standard.mdを再確認し、同じ開始・結果の再送を一件にする。game_slugや接続処理を名称から推測しない。今回Supabase・公開登録を変更しない。
validate_documents.pyは設計資料だけを検査する。ゲーム検査、実機、試遊、接続確認を合格扱いにしない。mainへ直接push・無断マージ・自動マージ・保護変更・公開はしない。作業ブランチとDraft PRで提出する。
