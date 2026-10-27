# 段階7：Vercel Preview・Stripe Sandbox での実環境検証の手順

Stripe の Sandbox（テスト決済）と Vercel の Preview で、決済・返金・異議申し立て・決済監視を実際の環境で確かめるための手順です。
**本番（Production・本番の Firebase・Stripe の Live）には一切触れません。** 本番の Stripe 決済（Live）は未実装・無効のままです。

この文書には環境変数の**名前だけ**を書きます。値（秘密鍵・トークン・URL の秘密の部分）は書かないでください。

---

## 0. 前提と全体の流れ

| 項目 | 内容 |
| --- | --- |
| ブランチ | `feature/stripe-checkout`（main には触れない） |
| Preview の Firebase | `uranai-preview`（コードで固定。これ以外のプロジェクトではテスト決済を受け付けない） |
| 本番の Firebase | `uranai-b6edf`（Preview から接続しようとすると、データベースへのアクセスを停止する） |
| Stripe | Sandbox（`sk_test_`）だけ。Live のアカウント・キー・Webhook の送信先は作らない・変えない |
| 決済の記録 | Sandbox の決済は `livemode=false` で記録し、**売上・店舗の取り分（30%）・月次精算・精算の調整には含めない**（§8） |

流れ：§1 事前の設定 → §2 push と Preview のデプロイ → §3 接続先の確認 → §4 運営だけのテスト（`SITE_STATUS=development`）→
§5 一般のお客さんのテスト（`SITE_STATUS=open`）→ §6 development に戻す → §7 本番に影響が無いことの確認

---

## 1. 事前の設定（運営者が手で行う）

### 1.1 Vercel の環境変数（Preview 専用）

**登録先は「Preview」だけ**にし、できればブランチ `feature/stripe-checkout` に限定します。「All Environments」・「Production」には登録しません。
変数を変えたら Redeploy が必要です（既存のデプロイには反映されない）。

| 変数 | 用途 | 必須 | 注意 |
| --- | --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Firebase の接続先 | 必須 | `uranai-preview` |
| `FIREBASE_CLIENT_EMAIL` | サービスアカウント | 必須 | `uranai-preview` のサービスアカウント（`…@uranai-preview.iam.gserviceaccount.com`） |
| `FIREBASE_PRIVATE_KEY` | サービスアカウントの秘密鍵 | 必須 | `uranai-preview` のもの。**本番の鍵を登録しない** |
| `PRODUCTION_FIREBASE_PROJECT_ID` | 本番の取り違えの判定 | **必須** | 本番のプロジェクトID。未設定だと Preview はデータベースへのアクセスを停止する |
| `STRIPE_TEST_FIREBASE_PROJECT_ID` | テスト決済のプロジェクト | 必須 | `FIREBASE_PROJECT_ID` と同じ値 |
| `STRIPE_TEST_CHECKOUT` | テスト決済のスイッチ | 必須 | `on` |
| `STRIPE_SECRET_KEY` | Sandbox の秘密鍵 | 必須 | `sk_test_` で始まるもの（制限付きキー `rk_test_` は今のコードでは使えない） |
| `STRIPE_WEBHOOK_SECRET` | Webhook の署名の値 | 必須 | Preview 用の送信先の `whsec_`（§1.3） |
| `SESSION_SECRET` | Cookie の署名 | 必須 | 32文字以上の乱数。**本番と別の値** |
| `PAYMENT_PROVIDER` | 一般のお客さんの決済 | §5 で必須 | `stripe` |
| `SITE_STATUS` | 公開状態 | 必須 | 最初は `development`。§5 の間だけ `open` |
| `ENABLE_TEST_PAYMENT` | 無料テスト | — | 設定しない（`true` だと一般のお客さんの決済は受け付けない） |
| `OPS_DIAGNOSTICS_TOKEN` | 接続先の診断（§3） | 推奨 | 32文字以上の乱数。Preview だけ |
| `DB_PROVIDER` | 保存先 | 任意 | `firestore`（`FIREBASE_PROJECT_ID` があれば自動で Firestore） |
| `DATA_ENCRYPTION_KEY` | 口座情報の暗号化 | 任意 | 口座の登録を試すときだけ。本番と別の値 |
| `ADMIN_SETUP_TOKEN` | 最初の運営アカウントの作成 | 任意 | `uranai-preview` に運営アカウントが無いときだけ。作成後に削除 |
| `CRON_SECRET` | 定期処理の認証 | 任意 | Preview では Vercel の Cron は動かない |
| `APP_URL` | 公開 URL | — | **設定しない**（Preview はブランチの固定 URL を自動で使う。本番のドメインを指す値は無視する） |

**Preview に絶対に設定しないもの**

- `STRIPE_LIVE_CHECKOUT`・`STRIPE_LIVE_OPERATOR_TEST`（本番決済のスイッチ。あればテスト決済も止まる）
- `sk_live_`・`pk_live_`・`rk_live_` のキー（`STRIPE_SECRET_KEY`・`STRIPE_PUBLISHABLE_KEY`・`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`・`STRIPE_RESTRICTED_KEY`）
- `STRIPE_API_BASE`（ローカルの自動テスト専用）・`FIRESTORE_EMULATOR_HOST`
- `PAYMENT_PROVIDER=mock`・`ALLOW_MOCK_PAYMENTS_IN_PRODUCTION`・`PAYJP_*`
- **本番の PostgreSQL を指す `DATABASE_URL`**（§1.5）

`VERCEL_ENV`・`VERCEL_URL`・`VERCEL_BRANCH_URL`・`VERCEL_PROJECT_PRODUCTION_URL` は Vercel が自動で設定します。

### 1.2 本番の Firebase と Preview の Firebase の取り違えの防止

コードでの防止（設定を誤っても停止する）：

- Preview のデータベースへの接続は、次のすべてを満たすときだけ（`lib/firestore/target-guard.ts`。Firebase Admin SDK の初期化の前に判定し、満たさなければ接続しない）：
  - `FIREBASE_PROJECT_ID` が `uranai-preview` と完全に一致する（本番の `uranai-b6edf` は `PRODUCTION_FIREBASE_PROJECT_ID` の値に関係なく必ず拒否。別のプロジェクトも拒否）
  - `PRODUCTION_FIREBASE_PROJECT_ID` が設定されていて、本番のID（`uranai-b6edf`）と完全に一致する（誤記・入れ違いは拒否）
  - `FIREBASE_CLIENT_EMAIL` が `uranai-preview` のサービスアカウント（`…@uranai-preview.iam.gserviceaccount.com`）
  - Preview では Firestore Emulator の設定があっても、この判定を省略しない
- Preview のテスト決済は `FIREBASE_PROJECT_ID` が `uranai-preview` かつ `STRIPE_TEST_FIREBASE_PROJECT_ID` と一致するときだけ（`lib/payments/stripe-guard.ts`）。
  本番のプロジェクトID（`uranai-b6edf`）なら拒否
- Preview で Firestore Emulator・`STRIPE_API_BASE`・本番用キー・本番決済のスイッチがあれば、テスト決済を受け付けない

運営者の確認：

- サービスアカウントの JSON は `uranai-preview` のものを使う（メールアドレスが `@uranai-preview.iam.gserviceaccount.com` で終わる）
- 本番の鍵を Preview に貼り付けない。Vercel の変数の一覧で、登録先（Environment）が「Preview」だけであることを確かめる
- デプロイの後、§3 の診断で4項目がすべて true であることを確かめる

### 1.3 Preview の Firestore の rules・インデックスの適用

Firebase CLI で、**必ず `--project uranai-preview` を付けて**実行します（付け忘れると既定のプロジェクトに適用される）。
実行の前に `firebase projects:list` と `firebase use` で、今の既定のプロジェクトを確かめてください。

```bash
firebase deploy --only firestore:rules   --project uranai-preview   # ブラウザからの読み書きを全面禁止（firestore.rules）
firebase deploy --only firestore:indexes --project uranai-preview   # firestore.indexes.json の複合インデックス2件
```

- 複合インデックスは決済監視の一覧（`paymentAlerts`：`status`＋`lastSeenAt` 降順、`status`＋`mode`＋`lastSeenAt` 降順）だけに必要です。
  ほかの検索は単一フィールドのインデックス（自動）で動きます
- インデックスの作成には時間がかかります。Firebase コンソールの「インデックス」で状態が「有効」になってから、決済監視の画面を開いてください
  （作成前に開くと Firestore がエラーを返す。Firestore Emulator はインデックスを確かめないため、自動テストでは検出できない）
- `firebase deploy` を `--only` なしで実行しない（Hosting・Functions など、ほかの設定に触れないため）

### 1.4 Stripe の Sandbox：Webhook の送信先と必要なイベント

- Stripe の Dashboard を **Sandbox（テスト環境）に切り替えてから**作業する。Live の画面では何も作らない
- 送信先の URL：`https://<ブランチの固定URL>/api/webhooks/stripe`（デプロイごとの URL ではなく、ブランチの固定 URL。§1.6 の保護の回避を付ける）
- API のバージョン：アプリの SDK（stripe 23.0.0）が使う `2026-09-30.endive` に合わせる
  （通知の中身は使わず Stripe API から取り直すが、通知の形の違いを避けるため）
- 作成した送信先の署名の値（`whsec_`）を、Vercel の Preview の `STRIPE_WEBHOOK_SECRET` に登録する
- 登録するイベント（16種類）：

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
charge.refunded
charge.refund.updated
refund.created
refund.updated
refund.failed
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
charge.dispute.funds_withdrawn
charge.dispute.funds_reinstated
charge.updated
charge.succeeded
```

- 決済方法：カード（Apple Pay・Google Pay はカードのウォレットとして扱われる）を有効にする。PayPay は Sandbox で有効にできるか確認する。
  アプリが決済画面ごとに、表示する方法をカードと PayPay に絞る（`allowed_payment_method_types`）。Managed Payments は決済画面ごとに無効を指定する

### 1.5 Vercel のビルドの PostgreSQL のマイグレーション

`package.json` の `vercel-build` は `tsx scripts/migrate.ts && next build` です。Vercel は `vercel-build` があればビルドでこれを実行します。

- **Vercel の Preview（`VERCEL_ENV=preview`）では、`DATABASE_URL` があってもマイグレーションを実行しません。**
  判定はデータベースのクライアントを読み込む前に行い、接続もしません（`src/lib/db/migration-guard.ts`。単体テスト `tests/migration-guard.test.ts`）。
  ビルドのログには理由だけを出します：`[migrate] Vercel Preview (VERCEL_ENV=preview); skipping migrations. …`（接続先・パスワードは出さない）
- Preview 以外は以前どおりです：`DATABASE_URL` があれば適用（Vercel の本番・ローカルの開発）、無ければスキップ
- それでも、Preview に本番の `DATABASE_URL` を登録しないでください（Preview は Firestore を使うので不要。ビルド以外での誤用を防ぐため）。
  検証の前に、Vercel の変数の一覧で `DATABASE_URL` の登録先を確かめてください

### 1.6 Vercel の Deployment Protection を保ったまま Webhook を受け取る

Preview の保護（Vercel Authentication など）が有効なままだと、Stripe からの通知は Vercel のログイン画面に止められ、届きません。
**保護は無効にせず**、Vercel の「Protection Bypass for Automation」（自動化のための保護の回避）を使います。

- Vercel のプロジェクトの設定で、保護の回避の値を作成する（運営者が手で行う）
- Stripe はヘッダーを付けられないため、送信先の URL のクエリに回避の値を付ける：
  `https://<ブランチの固定URL>/api/webhooks/stripe?x-vercel-protection-bypass=<回避の値>`
  （パラメーター名・使い方は、作業の時点の Vercel の文書で確かめてください）
- **署名の確認は変わりません。** アプリは本文（生の文字列）と `Stripe-Signature` ヘッダーだけで署名を確認し、URL・クエリは読まない・記録しない
  （`app/api/webhooks/stripe/route.ts`。単体テスト `tests/preview-runbook.test.ts` で確認）。回避の値を知っていても、署名の無い通知は 400 で拒否する
- 回避の値は秘密です。この文書・チャット・スクリーンショット・Git に書かない。
  Stripe の Dashboard の送信先の URL には表示されるため、Dashboard を見られる人を限る。Vercel のログに URL のクエリが出るかは作業の時点で確かめる
- 検証が終わったら、回避の値を無効にする（作り直す）
- 検証する人の端末（スマホを含む）は、Vercel にログインするか、Vercel の共有リンクを使って Preview を開く（Stripe の決済画面からの戻り先も同じドメイン）

### 1.7 push による自動デプロイの注意

- `vercel.json` で自動デプロイを止めているのは `backup-tools`・`dev-mode` だけです。**`feature/stripe-checkout` に push すると Preview が自動でデプロイされます**
- **main に push すると本番がデプロイされます。** push の前に `git branch --show-current` が `feature/stripe-checkout` であることを確かめ、
  `git push origin feature/stripe-checkout` のようにブランチを明示する
- Preview の環境変数・rules・インデックス・Stripe の送信先を先にそろえてから push する（そろう前のデプロイは、決済を受け付けない状態で動く。安全側）
- Preview のデプロイは、ほかの人にも URL が分かる可能性がある。保護（§1.6）を無効にしない

---

## 2. デプロイ

1. §1 がすべて終わっていることを確かめる（`SITE_STATUS=development` の状態）
2. 承認を得てから `feature/stripe-checkout` を push し、Vercel で Preview のデプロイが終わるのを待つ
3. ビルドのログで、`[firestore-target]` の警告が出ていないこと、`[migrate] Vercel Preview (VERCEL_ENV=preview); skipping migrations` が出ていること（§1.5）を確かめる

## 3. 接続先の確認（決済の前に必ず）

- `GET /api/ops/firebase-target`（`Authorization: Bearer <OPS_DIAGNOSTICS_TOKEN>`）：
  `projectIdIsPreview`・`productionProjectIdIsExpected`・`clientEmailBelongsToPreview`・`projectIdMatchesStripeTestProject` がすべて true
  （Firebase には接続しない診断。値は返さない）
- `GET /api/health`：データベースが Firestore で ok。決済の表示は、`SITE_STATUS=development` の間は
  「stripe (決済を受け付けていません：…)」（一般のお客さんの決済は止めている。運営のテスト決済は §4 で確かめる）、
  §5 で `open` にした後は「stripe (test: Sandbox。売上・精算には含めない)」
- 本番のサイトの `/api/health` が変わっていないこと
- Stripe の Dashboard（Sandbox）で、送信先へのテストの送信が 2xx で届くこと（届かなければ §1.6）
- 署名の誤った通知を1件送ると 400 になり、運営画面の「決済監視」に「署名を確認できない通知（少なくとも1件）」が記録されること

## 4. 運営だけのテスト（`SITE_STATUS=development`）

一般の方・店舗アカウントには準備中を表示し、決済は受け付けません。運営アカウントでログイン中の人だけが `/fortune?pay=stripe-test` からテスト決済できます。

1. `uranai-preview` に運営アカウント（`/admin/setup` または既存）・テスト用の実店舗を作る
2. 運営アカウントでログインし、実店舗の QR（`/s/<店舗コード>`）→ `/fortune?pay=stripe-test` → 占いを選ぶ → Stripe の決済画面
3. 確かめること（テストカードは作業の時点の Stripe の文書で確認）：

| 場面 | 操作 | 期待する結果 |
| --- | --- | --- |
| 成功 | 成功するテストカード | 戻り先から入力・結果へ。取引は1件だけ（Webhook と戻り先の両方が来ても1件）。店舗30円・運営70円。「テスト決済・集計外」 |
| 3Dセキュア | 認証が必要なテストカード | 認証の後に成功 |
| 拒否 | 拒否されるテストカード | 決済画面で支払い直せる。注文は閉じない |
| キャンセル | 決済画面の「戻る」 | 注文が残り、もう一度払える |
| 期限切れ | Sandbox で Checkout Session を失効させる | `checkout.session.expired` で注文が閉じる |
| 非同期 | PayPay のテストの承認・失敗（使える場合） | 確定待ちの間は占えない。成功で占える・失敗で注文が失敗 |
| 再表示 | 結果・戻り先の再読み込み、ブラウザの戻る | 同じ結果を表示（24時間）。二重に記録しない |

4. 返金・異議申し立て（Stripe の Dashboard（Sandbox）で操作）：

| 場面 | 期待する結果 |
| --- | --- |
| 全額の返金 | 取引が返金に。占い権利を止める |
| 一部の返金 | 返金の額を記録（運用では原則として一部返金はしない） |
| 返金の失敗（返金が失敗になるテストカード） | 権利を戻す操作（決済履歴）で戻せる |
| 異議申し立ての発生・勝訴・敗訴 | 状態を Stripe から取り直して反映。照合できない通知は「決済要確認」に記録 |

5. 決済監視（§9）：「今すぐ点検」を実行し、結果が表示されること・二重に押すと「ほかの点検を実行中」と出ること

## 5. 一般のお客さんのテスト（`SITE_STATUS=open`）

**Preview の変数だけ**を変えます（本番の `SITE_STATUS` には触れない）。

1. Preview の `SITE_STATUS=open`・`PAYMENT_PROVIDER=stripe`（`ENABLE_TEST_PAYMENT` は無し）にして Redeploy
2. ログインしていない端末（Vercel の共有リンクなどで Preview を開ける端末）で、実店舗の QR → 占いの選択 → 「同意して100円を支払う」→ Stripe の決済画面 → 結果
3. §4 の表の場面を、一般のお客さんの流れでも確かめる
4. 停止中の店舗の QR では決済できないこと

## 6. テストの終了：development に戻す

1. Preview の `SITE_STATUS=development` に戻し、`PAYMENT_PROVIDER` を元の値にして Redeploy
2. 一般の方に準備中が表示され、`/api/checkout` が受け付けないことを確かめる
3. 不要になった `ADMIN_SETUP_TOKEN`・`OPS_DIAGNOSTICS_TOKEN` を削除する。保護の回避の値を無効にする（§1.6）
4. Stripe の Sandbox の送信先は、次の検証まで使わないなら無効にする

## 7. 本番に影響が無いことの確認

- [ ] Vercel の Production の変数に `STRIPE_TEST_CHECKOUT`・`sk_test_` のキー・`STRIPE_API_BASE`・`OPS_DIAGNOSTICS_TOKEN` が無い
- [ ] Preview の変数がすべて Preview（ブランチ限定）だけに登録されている。「All Environments」が無い
- [ ] Preview に本番の Firebase の認証情報・本番の `DATABASE_URL`・本番用の Stripe のキーが無い
- [ ] rules・インデックスの適用先が `uranai-preview` だけ（コマンドの履歴の `--project` を確かめる）
- [ ] Stripe の作業が Sandbox だけ。Live のアカウントの送信先・キー・設定を変えていない
- [ ] main に push していない。本番のデプロイが増えていない
- [ ] 本番のサイトの `/api/health` が検証の前後で変わっていない（本番の決済は無効のまま）
- [ ] 本番の Firestore の取引・注文の件数が変わっていない（確かめる場合は読み取りだけ）

## 8. Sandbox の決済は精算に含まれない（仕様）

- Sandbox の決済は `livemode=false` で記録し、**売上・店舗の売上画面・店舗の取り分（30%）・月次精算・精算の調整に含めません**（`lib/payments/kind.ts`）。
  運営の決済履歴には「テスト決済・集計外」と表示します
- 取引には店舗30円・運営70円を記録するので、Preview では「取り分の記録」と「精算に含まれないこと」までを確かめます
- 精算の確定・振込後の返金・異議申し立ての調整・繰越の正しさは、ローカルの自動テスト
  （`npm run e2e:stripe-settlement`・`npm run e2e:stripe-settlement-safety`。本番モードの模擬と Firestore Emulator）で確かめています。
  本番の決済での確認は、本番決済を実装する段階で行います

## 9. 決済監視の実行方法と制限

- 運営画面「決済監視」の「今すぐ点検（読み取りのみ）」。決済の確定・返金・再決済・精算の変更はしない
  （書き込むのは、点検の実行状態・監査ログ・異常の記録だけ）
- 同時に1つだけ（Firestore のトランザクションで取るロック。期限は5分）。実行中に押すと「ほかの点検を実行中」と表示して開始しない
- 点検の時間の上限は45秒（ロックの期限より短い）。件数の上限：確定待ち500・期間内の取引3000・注文3000・確定済みの精算300・1つの精算の取引3000・
  Stripe の照合50・異常の記録200。上限・時間切れ・読み取りの失敗があれば「一部未確認」（「異常なし」とは表示しない）
- **関数の実行時間：** アプリでは `maxDuration` を設定していません（Vercel の既定の上限を使う）。既定の上限はプランと Fluid Compute の設定で変わるため、
  作業の前に Vercel のプロジェクトの設定で確かめてください。上限が45秒より短いと、点検は途中で止められます。その場合はロックが期限（5分）まで残り、
  監視の状態は「実行中」→「前回の監視の点検が途中で止まりました」と表示されます（「異常なし」にはならない）。§11 を参照
- Preview では Stripe の照合は Sandbox だけです。次のときは「一部未確認」になります：Stripe の接続の設定が欠けている・Stripe の読み取りに失敗した・
  照合が50件または時間の上限を超えた・モードの違う注文（本番の注文）がある・件数の上限を超えた・Firestore の読み取りに失敗した・異常の記録に失敗した
- 確定待ちの注文の検出は、確定待ちのまま60分を過ぎたものだけです。Preview で確かめるには60分待ちます
- Vercel の Cron は Production でだけ動くため、Preview では定期の点検はありません（手動の「今すぐ点検」だけ）
- 署名を確認できない通知の件数は、間引いて記録した「少なくとも」の値です（正確な総数ではない）

## 10. 公開前に残る未検証事項

- Stripe の本番決済（Live）：未実装・無効。本番のキー・Webhook・本番の Stripe の照合は未検証
- Vercel の関数の実行時間の上限（プラン・Fluid Compute）と、点検・Webhook・決済の確定の実行時間の関係（§11）
- 本番の Firestore へのインデックスの適用と、決済監視の画面の表示
- 本番のデータ量での点検の上限値（45秒・件数）の妥当性
- Vercel の複数のインスタンスでの、署名の不正・5xx の記録の件数と、点検のロックの動作
- 定期の点検（Cron）・異常の通知（メールなど）：未実装
- 本番のドメインでの Apple Pay・Google Pay・PayPay の表示
- Vercel のログに URL のクエリ（保護の回避の値）が記録されるか
- 本番での精算・振込後の返金・異議申し立ての調整（本番の決済でしか確かめられない）

## 11. 関数の実行時間（確認の後に設定する）

アプリが Vercel で使う処理と、時間がかかる要因：

| 処理 | 場所 | 時間がかかる要因 | 途中で止められた場合 |
| --- | --- | --- | --- |
| Webhook | `app/api/webhooks/stripe/route.ts` | Stripe API の取り直し（1回の上限20秒・再試行2回）・Firestore のトランザクション | 通知は「処理済み」にならないので、Stripe の再送で処理し直す（記録は1件のまま） |
| 戻り先の確定 | `app/payment/return/page.tsx` | 同上 | Webhook でも確定する。画面は再読み込みで状態を表示 |
| 決済画面の作成 | `app/api/checkout/stripe-session/route.ts` | Stripe API（Session の作成） | 同じ注文・同じ期限なら同じ Session（冪等キー）。もう一度押せばよい |
| 今すぐ点検 | `app/admin/(console)/payment-monitor/page.tsx`（Server Action） | 点検（上限45秒） | ロックは期限（5分）で外れる。状態は「途中で止まりました」と表示 |

Vercel のプランと Fluid Compute の設定を確かめた後、上限が45秒より長く設定できるなら、上の4つのファイルに
`export const maxDuration = <秒>;`（点検の45秒より10秒以上長く、プランの上限以下）を追加します。
追加すると、単体テスト（`tests/preview-runbook.test.ts`）が点検の時間の上限との関係を確かめます。
