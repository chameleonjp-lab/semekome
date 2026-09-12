# 全計画書の目次

**実装基準は第4版（current）です。** 過去版は経緯を確認するための保管資料であり、複数の版を同時に仕様として使わないでください。

|版|内容|扱い|
|---|---|---|
|[第4版](current/PRODUCT_REQUIREMENTS.md)|複数の敵車内室、敵30人、討伐20秒後の復活。7部位・7門・コア攻撃方式を維持|現在の実装基準。本文・付属データ17ファイル|
|[第3版](archive/v3/PRODUCT_REQUIREMENTS.md)|7部位・7門・コア攻撃方式へ変更|履歴のみ。13ファイル|
|[第2版](archive/v2/PRODUCT_REQUIREMENTS.md)|原作再現から独自作品の要件へ変更|履歴のみ。11ファイル。2制御盤方式は撤回済み|
|[第1版](archive/v1/IMPLEMENTATION_PLAN.md)|初期の戦闘調査・再現計画|履歴のみ。7ファイル。原作一致という目標と候補データの実装利用は撤回済み|

## 最新版を使う順番

[AI_HANDOFF.md](current/AI_HANDOFF.md)と[計画書全文](current/PRODUCT_REQUIREMENTS.md)を先に読み、[勝敗の詳細](current/SEVEN_PART_CORE_RULES.md)と[敵の部屋・人数・復活](current/NPC_ROOMS_AND_RESPAWN.md)を確認します。

[REQUIREMENTS.json](current/REQUIREMENTS.json)は65件の要件、[ACCEPTANCE_TESTS.json](current/ACCEPTANCE_TESTS.json)は115件の未実施の検査計画です。[INITIAL_RULES.json](current/INITIAL_RULES.json)は初期設定、[ORIGINAL_CASES.json](current/ORIGINAL_CASES.json)は独自の弾・資材8種類、[ENEMY_ROSTER.json](current/ENEMY_ROSTER.json)は敵30人の名簿、[INTERIOR_LAYOUTS.json](current/INTERIOR_LAYOUTS.json)は部屋の接続案です。

[変更履歴](current/MIGRATION_NOTES.md)、[権利・由来確認](current/RIGHTS_REVIEW.md)、[素材台帳ひな形](current/ASSET_REGISTER_TEMPLATE.json)、[出典](current/SOURCES.json)、[元資料の検査記録](current/DOCUMENT_CHECKS.json)、[資料検査スクリプト](current/validate_documents.py)も同じ場所にあります。

## 保存形式と検査

計48ファイルのMarkdown・JSON・Pythonを元資料と同じ内容で保存します。PDF原本と配布ZIP原本は含めていません。[格納範囲](IMPORT_STATUS.md)と[ファイル別の照合記録](IMPORT_MANIFEST.json)を参照してください。

過去資料に「今回の配布一式へ旧版を含めない」とあるのは、その版の配布時点の説明です。このリポジトリではユーザーの全計画書格納依頼に従って履歴も分けて保管しますが、旧版を実装へ採用する意味ではありません。
