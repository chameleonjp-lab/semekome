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

## 通常画面の全戦走破

`npm run test:browser`は短い画面・入力・終局境界・設定・練習・通信契約の入口。初期配置から実時間7分相当を操作する`@full-playthrough`は`npm run test:browser:full`で両ブラウザーを実行する。戦場を直接書き換えず、検査側の読取観測とDOM入力だけを使う。完了証拠は別に保存し、短い画面検査や固定終局fixtureを全戦走破と表示しない。通常PRで自動実行する長いNode一戦を残し、全戦画面は工程締めで明示的に実行する。

## 検査batchの運用

ローカル・手動検査の実行単位を、小commitごとではなく一つの機能・原因修正・レビュー対応の区切り（batch）にする。検査範囲や合格基準を減らす規約ではない。[共有の参考規約](https://github.com/chameleonjp-lab/chameleonjp-browser-game-harness/blob/50229ded69378ed6392453e73856482eb78b7354/references/test-batching.md)のbatch部分だけを適用し、Semekome全体のハーネス採用版を更新したとは扱わない。

### batch開始と必要な検査

- batch ID、目的・終了条件、対象path、直接/推移依存、壊れ得る契約、risk、関連検査と全体検査の集合を先に記録する。sourceだけでなくtest・fixture・設定・lockfile・toolchain・生成物・環境も影響判定に含め、不明な範囲は広い側へ倒す。
- 編集中は必要な軽量検査と変更境界の関連Node/画面検査を維持する。高リスク（保存/schema、入力所有、asset decode、security/権限、結果確定/ランキング等）の異常系・統合検査は時間を理由に延期しない。これはランキング再開や外部接続の許可ではない。
- ゲーム/設定変更の全体は、`npm run check:docs`、`npm test`（短い検査と長い一戦の全件）、`npm run build`（型検査を含む）、差分検査。表示・入力・描画・browser依存の影響には`npm run test:browser`のChromium/WebKitも含め、工程締めの`npm run test:browser:full`は上記方針を維持する。関連unitだけを画面確認の代わりにしない。
- 資料だけなら資料・リンク・差分と変更した契約の整合性を全体として検査する。ただし拡張子だけで除外せず、生成元・設定・仕様・検査手順への影響も評価する。runtime検査を行わない場合は、実行関連内容の同一性、差分一覧、除外根拠と未実行範囲を明記する。過去の実行証拠を参照するなら元SHA・時刻も残し、現候補のruntime passとは呼ばない。

### 途中の全体再実行を延期できる条件

次をすべて満たす場合に限り、途中の全体再実行を延期できる。

1. 同じbatchの実測した全体passがあり、その終了時刻から現在までが0〜30分。直近の関連検査も現在候補で全件passしている。
2. 元passの正確なSHA/tree/dirty内容識別から現在候補までの累積diffを確認し、関連検査が直接・推移影響を覆い、未検査領域への非影響を説明できる。
3. toolchain・環境・lockfile・設定（runtime/build/testを含む）・test logicが同一で、高リスク変更や未解消のfail/blockedがない。
4. batch終了、最終候補、提出準備、merge/release判断の境界ではない。

延期は`not_run`とし、理由・未検査領域・次の実行契機を台帳へ残す。関連passや新commitで30分の起点を延長せず、別batchへ持ち越さない。30分を過ぎて作業を続ける際の検査判断、範囲拡大、環境変更、失敗、作業境界のうち最も早い時点で全体検査へ戻す。30分ごとの無用な定時起動は作らない。条件不成立なら必要な全体検査を実行する。

失敗は元の証拠を保ち、原因修正→失敗例と関連検査→必要な全体検査の順で確認する。既知failをdocs-only、flaky、時間不足や古いgreenで相殺しない。未実行・blocked・対象外もpassに数えない。

### 区切り・提出とCIの区別

区切りと最終提出では現在の提出SHAで適用される全体検査を行う。commit前の検査はtree/全内容・dirty差分の一致を別記録し、現在SHAの必須CIとは区別する。PR headとCIのmerge SHAを混同しない。未実行を明記したDraft PRは作れるが、検査完了・merge可能・公開可能を意味しない。

既存server/build成果物の再利用にはsource/tree、assets、依存lock、toolchain、build/test設定・環境のfingerprint一致が必要。不一致・不明なら再buildし、依存cache hitをpassにしない。秘密値をfingerprintへ保存しない。

この規約はQuality workflowや変更分類器の実装を変えない。通常のゲーム変更ではPR更新ごとに短い/長いNode検査・buildが動くため、一つのbatchをまとめてpushして重複発火を減らす。backup・協業・必要な途中共有は維持する。30分のCI結果キャッシュやmainの検査再利用が実装済みとはしない。必須check、browser opt-in、保護・公開gateを緩めない。

実行・延期の記録項目と既存記録の使い方は[検査台帳](TEST_REPORT.md#作業batchの検査台帳)を参照する。
