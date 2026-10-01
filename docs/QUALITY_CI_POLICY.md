# Quality CIの実行方針

通常のPull Request・featureブランチのQualityでは、資料検査、Node検査、型検査・ビルドを実行し、Chromium/WebKitのbrowser検査は既定でスキップする。browser用のインストール、フォント導入、検査、レポートartifactは削除せず、対象ステップをSkippedとして残す。

画面・入力・レイアウト・描画・ブラウザー依存の大きな変更を確認するときは、次のいずれかで明示的にbrowser検査を有効化する。

- ActionsのQuality workflowを対象ブランチで手動実行し、run_browserをtrueにする。
- Pull Requestへrun-browserラベルを付けた状態で、Qualityを再実行する。

browser検査をスキップしたQualityの成功は、Chromium/WebKitの回帰確認を意味しない。browserを有効化した実行で、Chromium/WebKitの両方とreport artifactを確認する。通常の小さなルール・資料変更では、短いQualityを優先して開発テンポを保つ。

## 公開工程1の検査分割

Qualityのジョブ名`verify`を維持する。自動実行はmainへのpushとPR更新（ラベル変更を含む）に限定し、作業枝のpushとの二重実行を除く。同一PRの古い実行だけ取り消し、main・手動実行は取り消さない。保護設定の読取は403だったため必須チェック設定の実値は未確認。保護設定を変更していない。

`npm test`は全Node検査、`npm run test:short`はrules/input/presentation/ci、`npm run test:long`はscenarios全件。標準勝利・敵勝利・25,000更新耐久・異なる保護fixtureをすべて残す。標準勝利は従来どおり一度の走破でG1〜G7と支援弾の実損傷を検証し、門ごとに初期状態からやり直さない。補給、保護、初期状態、期待境界の異なる古い回帰は統合しない。新しいscenarioは自動で長い分類へ入り、分類漏れをNode検査で拒否する。

README/AGENTSとdocs配下のmd/pdf/svg/webp/txtだけなら資料検査を完了し、依存物導入・Node・型・ビルド・配布物を省略する。実行時JSON、src、依存物、検査設定、未知のファイル、変更範囲取得失敗は短い検査・長い検査・型・ビルドを有効にする。表示側も保守的に一戦を実行する。ブラウザーはrun_browserまたはrun-browserを維持し、資料だけでも指定された場合はビルドして実行する。workflow全体を省略しない。

82要件・135手順に担当工程と確認対象への参照を追加した。`evidence_review`は部分実装と次の確認入口であり、合格結果ではない。既存のexecution_statusを維持する。実機・試遊・外部接続・公開は自動検査と区別する。
