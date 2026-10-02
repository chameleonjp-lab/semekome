# セメコメの公開と復旧

正式URL: https://chameleonjp-lab.github.io/semekome/

2026-10-02の「ページ公開まで進めてください」という依頼に基づき、既存のGitHub Pagesを公開先として採用する。mainへの直接pushや保護設定の変更は行わず、作業枝のPRとQualityを経由する。実機・試遊の未実施項目は[公開監査](RELEASE_AUDIT_AND_PUBLICATION.md)に残す。

## 配備

1. `ranking-manifest.json`の版・URL・代表slug・得点範囲と`public.games`を照合する。公開用接続値は`.env.production`に置く。配布してよいpublishable keyだけを使う。
2. PRの`run-browser`ラベルを使い、Qualityの資料・Node・ビルド・Chromium/WebKitの実行結果を確認する。
3. PRを取り込む。mainのQuality成功後、`Publish Pages`が同じコミットをビルドしてPagesへ配備する。別コミットのQuality成功では配備しない。
4. 配布物に`ranking-manifest.json`、`commit.txt`、正式URLと版のHTMLメタ情報、`THIRD_PARTY_LICENSES.txt`があることを確認する。
5. 公開URL・アセット・実ランキングを照合する。公開直後の登録は`is_active=true`で有効にし、実験場トップと`ranking.html?game=semekome_standard_v1`を確認する。試験用の高得点を公開ランキングへ残さない。
6. 公開URLで開始・中止・同じ番号の再送、ゲーム内結果・保存値・受付値を確認する。共有文は確定得点・競技条件・正式URLを使う。

`npm run verify:publication -- <公開コミットSHA>`はHTML、manifest、コミット、JS/CSS、22画像、ライセンス、公開設定、上位10件の実RPCを照合する読取検査。HTTPプロキシ環境のNode24では`NODE_USE_ENV_PROXY=1`を付ける。

## 戻す手順

直前公開版のSHAを公開記録から選び、成功したQualityがあることを確認して、同じworkflowを手動実行する。

```sh
gh workflow run pages.yml --ref main -f deploy_ref=<確認済み旧コミットSHA>
```

配備workflowはそのSHAのQuality成功を再確認する。古いブランチ名でなくSHAを指定し、mainの履歴を強制変更しない。公開URLの`commit.txt`、HTMLの版、manifest、JS/CSS、受付値を再確認する。manifestや得点範囲が異なる版へ戻す場合は、対応する登録値と未送信結果の互換性も確認する。

今回は最初の公開設定を用意するため、直前公開版がない場合はゲーム登録だけを`is_active=false`へ戻して受付・実験場掲載を止める。Pages自体の停止が必要ならGitHub Pagesの設定から配備を無効化する。既存プレイ・得点・利用者は削除しない。
