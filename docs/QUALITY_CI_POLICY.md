# Quality CIの実行方針

通常のPull Request・featureブランチのQualityでは、資料検査、Node検査、型検査・ビルドを実行し、Chromium/WebKitのbrowser検査は既定でスキップする。browser用のインストール、フォント導入、検査、レポートartifactは削除せず、対象ステップをSkippedとして残す。

画面・入力・レイアウト・描画・ブラウザー依存の大きな変更を確認するときは、次のいずれかで明示的にbrowser検査を有効化する。

- ActionsのQuality workflowを対象ブランチで手動実行し、run_browserをtrueにする。
- Pull Requestへrun-browserラベルを付けた状態で、Qualityを再実行する。

browser検査をスキップしたQualityの成功は、Chromium/WebKitの回帰確認を意味しない。browserを有効化した実行で、Chromium/WebKitの両方とreport artifactを確認する。通常の小さなルール・資料変更では、短いQualityを優先して開発テンポを保つ。
