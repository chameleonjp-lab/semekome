# semekome の作業基準

現行はdocs/plans/current/の第5版。AI_HANDOFF.mdとPRODUCT_REQUIREMENTS.mdを全文読み、MAP_ADOPTION.md、SCREEN_FLOW_AND_BATTLEFIELD.md、RESULTS_SCORE_RANKING.mdも読む。archive/v1〜v4は履歴。
ユーザー指定と補足案を区別する。採用配置の左右方向、7部位7門核一撃、敵30人20秒、主人公5秒観戦復活、相互侵入、広場突破、名前登録とカウントダウン、結果と上位10位を省かない。図にない核と7門を撤去しない。原作素材・名称替えのデータを入れない。
4砲台・人数配分・広場担当数・得点式・寸法は補足案。図の採用を当たり判定や実機合格にしない。ランキング接続時は共有リポジトリの規約と実登録を確認し、未確認のgame_slug・受付処理を推測しない。
資料検査、ゲーム検査、試遊、実機、接続を区別し、未実施を合格にしない。現行validate_documents.pyは既定で読み取りのみ。--write-report指定時だけDOCUMENT_CHECKS.jsonを更新する。履歴の検査ファイルは変更しない。
mainへの直接push・無断マージ・自動マージ・保護変更・公開を禁止する。作業ブランチとDraft PRで提出する。
