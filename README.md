# semekome / セメコメ

弾を運び、補助員に仕事を任せ、敵の外装7部位を壊して7つの門を突破し、核へ突進する一人用アクション戦術ゲームです。自陣は左、敵陣は右。敵30人は倒されてから20秒、主人公は5秒の観戦後に復活します。

公開URL: https://chameleonjp-lab.github.io/semekome/

PR #73の5工程計画と後続PR #74〜#77を照合し、正式得点・実ランキング登録・公開設定の漏れを修正しています。対応22項目、検査の証拠、未実施の実機・試遊などは[公開監査](docs/RELEASE_AUDIT_AND_PUBLICATION.md)を参照してください。[計画書](docs/plans/current/RELEASE_IMPLEMENTATION_PLAN.md) / [第5版の製品要件](docs/plans/current/PRODUCT_REQUIREMENTS.md) / [検査記録](docs/TEST_REPORT.md) / [公開・復旧手順](docs/PUBLISHING.md)

## 遊び方

ホームの3つの練習で運搬・迎撃・門と核を学び、「通常戦を始める」から名前、補給4種類8個、補助員3型から2人、敵の6作戦、難易度を選びます。3秒のカウントダウン後に開始します。設定、名前、音、練習の達成はこの端末に保存します。

- 移動: 左のパッド、矢印またはWASD。
- 拾得・受渡し・装填・修理: 近くで右の作業ボタン。砲台の操作位置に立つと自動発射します。
- 近接攻撃: 敵と接触しているときに攻撃ボタンまたはX。
- 突進: 突進ボタンまたはSpace。移動方向、停止時は最後の移動方向へ進みます。
- 味方命令: 「味方」でP2/P3へ砲撃、防衛する室、侵入する室、取消しを指示します。
- 停止・説明: 画面の停止と「?」。画面非表示でも停止し、再開は明示操作です。

7門を通った後、敵の核そのものへ突進を当てると勝利します。歩いて触れるだけでは勝利しません。結果に勝敗、確定スコア、実戦の記録、上位10位、共有・コピー、実験場リンク、再戦、戦闘記録保存を表示します。

ランキング対象は標準作戦・標準難易度・標準補給・運搬型2人です。他の通常設定は開始・終了だけを記録し、練習は外部へ送信しません。得点は勝利基礎100000＋max(0, 外装破壊×1000＋一度でも倒した敵×20＋勝利時の残秒×10−主人公死亡×100)。同じ敵の再討伐は得点に加算しません。

開始・終了の通信失敗では同じ番号で再送し、未送信結果を新しい試合で上書きしません。未送信がある間もランキング対象外で遊べます。実ランキングが空または取得失敗なら、その状態を表示します。

## 開発と検査

Node.js 24以上。

```sh
npm ci
npm run dev
npm run check:docs
npm test
npm run build
npx playwright install --with-deps chromium webkit
npm run test:browser
npm run test:browser:full
```

`npm run dev`は http://127.0.0.1:4173/ 。開発時は公開接続を設定しない限り外部へ送信しません。`npm test`は短いルール/入力/表示と長い通常戦/耐久の両方を含みます。全戦DOM操作の試験は長いため別入口です。自動検査の端末viewportはiPhone実機の代わりではありません。

mainのQuality成功後、同じコミットを`Publish Pages`で公開します。HTMLとmanifestでクライアント版、`commit.txt`で公開コミットを確認できます。共有の公開キーだけを`.env.production`に含め、秘密キーは使いません。公開後の読取検査は`npm run verify:publication -- <公開SHA>`。必要に応じて確認済み旧SHAを同じ配備workflowから戻せます。

画像22点は[素材台帳](docs/VISUAL_ASSET_INVENTORY.md)、音は独自Web Audio発振、依存物の利用条件は公開ページの「使用ライブラリ」に記載します。実装判断と過去の証拠は[引き継ぎ](docs/plans/current/AI_HANDOFF.md)と[実装判断](docs/DESIGN_DECISIONS.md)に残しています。
