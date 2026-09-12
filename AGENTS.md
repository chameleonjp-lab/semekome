# semekome の資料を扱う際の基準

実装前に `docs/plans/current/AI_HANDOFF.md` と `docs/plans/current/PRODUCT_REQUIREMENTS.md` を全文読む。外装・門・コアは `SEVEN_PART_CORE_RULES.md`、敵の部屋・30人・20秒復活は `NPC_ROOMS_AND_RESPAWN.md` も参照する。

`docs/plans/current/` は第4版の実装基準。`docs/plans/archive/` は履歴であり、撤回された制御盤方式・敵3人・敵5秒復帰・原作再現目標などを再導入しない。原作の画像・音・キャラクター表現や、旧版の原作アイテム候補を実装データへ混ぜない。

ユーザー指定と設計提案を区別する。7部位・7門・有効なコア攻撃による勝敗・敵30人・各人の討伐20秒後の復活を、負荷や難易度調整の名目で減らさない。

この格納作業は資料整備だけであり、ゲームの受け入れ検査・試遊・iPhone実機確認は未実施。資料の検査結果をゲームの検査合格と呼ばない。

`validate_documents.py` は `DOCUMENT_CHECKS.json` を上書きする。元資料の照合時は一時コピーで実行する。資料を更新した場合は、変更理由と関連する要件・検査の変更も記録する。

mainへ直接pushせず、作業ブランチとDraft Pull Requestを使う。マージ・公開・保護設定変更は勝手に行わない。
