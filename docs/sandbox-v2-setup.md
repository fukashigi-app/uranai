# 新しい検証環境（個人事業主の Stripe の Sandbox）のセットアップ手順

個人事業主の Stripe アカウントの Sandbox を、既存の Preview・Production に影響を与えずに検証するための手順です。
この文書には環境変数の**名前だけ**を書きます。値（秘密鍵・キー・アカウントの ID・URL の秘密の部分）は書かないでください。

---

## 0. 構成

| 項目 | 既存の Preview（維持） | 新しい検証環境 |
| --- | --- | --- |
| Vercel | 同じプロジェクトの Preview（`preview/stripe-verification`） | 同じプロジェクトの Preview（**専用のブランチ**。名前は作成のときに決める） |
| Firebase | `uranai-preview` | **`uranai-stripe-sandbox-v2`**（Firestore：`asia-northeast1`・本番環境モードで作成済み。コードの一覧に追加済み） |
| Stripe | 旧 Sandbox | 個人事業主のアカウントの Sandbox |
| `STRIPE_ACCOUNT_ID` | 任意（今までどおり無し） | **必須**（キーの持ち主を Stripe API で確かめる） |
| 定期処理（Cron） | 動かない（Cron は Production だけ） | 動かない（運営画面の手動の操作で確かめる） |
| Production・main | 変更しない | 変更しない |

### 安全の仕組み（ガードは無効にしない）

- Preview で使える Firebase のプロジェクトは、**コードに固定した一覧**（`src/lib/firestore/target-guard.ts` の `PREVIEW_FIREBASE_TARGETS`）だけ。環境変数では広げられない
- 本番の Firebase プロジェクトは、一覧・環境変数の値に関係なく Preview から必ず拒否する
- `FIREBASE_CLIENT_EMAIL` は、接続先と**同じプロジェクト**のサービスアカウントだけ（別の Preview 用のプロジェクトのものも拒否）
- 新しい検証環境では `STRIPE_ACCOUNT_ID` が必須。決済画面の作成・確定・Webhook の処理の前に、キーの持ち主のアカウントを Stripe API で確かめる。
  違えば受け付けない（旧 Sandbox のキーが残っていても、新しい環境で決済・記録をしない）
- どれか1つでも合わなければ、データベースへの接続・決済を止める（fail-closed）

---

## 1. コードの一覧（済み）

`src/lib/firestore/target-guard.ts` の `PREVIEW_FIREBASE_TARGETS` に、次の1件を追加済みです（`SANDBOX_V2_FIREBASE_PROJECT_ID`）：
`{ projectId: "uranai-stripe-sandbox-v2", requireStripeAccountId: true }`

- 形の不正な ID・本番の ID・重複は、読み込みのときに例外になる
- 単体テスト（`tests/preview-sandbox-target.test.ts`）で、一覧の内容・接続先の判定・`STRIPE_ACCOUNT_ID` の必須・本番の拒否を確かめている
- この変更は commit・push の後に、専用のブランチの Preview で有効になる（承認の後）

---

## 2. 運営者が行う操作

### 2.1 Firebase

- プロジェクト `uranai-stripe-sandbox-v2`（Firestore：`asia-northeast1`・本番環境モード）は作成済み。無料の Spark プランのままにする（**Blaze（有料）にしない**）
- サービスアカウントの鍵を発行する（`…@uranai-stripe-sandbox-v2.iam.gserviceaccount.com`。鍵のファイルは Git・チャット・スクリーンショットに置かない）
- rules とインデックスを適用する：`firebase deploy --only firestore:rules,firestore:indexes --project uranai-stripe-sandbox-v2`
  （本番環境モードの初期の rules はすべて拒否。アプリはサーバーの Admin SDK だけで読み書きするので rules の影響は受けないが、リポジトリの rules に合わせる）

### 2.2 Vercel（Preview・**専用のブランチだけ**に登録）

「Preview」の環境で、**ブランチを指定**して登録します。「Preview 全体」「All Environments」「Production」には登録しません。
変数を変えたら Redeploy が必要です。

| 変数名 | 内容 |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `uranai-stripe-sandbox-v2` |
| `FIREBASE_CLIENT_EMAIL` | `uranai-stripe-sandbox-v2` のサービスアカウント（`…@uranai-stripe-sandbox-v2.iam.gserviceaccount.com`） |
| `FIREBASE_PRIVATE_KEY` | 上のサービスアカウントの鍵 |
| `PRODUCTION_FIREBASE_PROJECT_ID` | 本番のプロジェクトの ID（今の Preview と同じ） |
| `STRIPE_TEST_FIREBASE_PROJECT_ID` | `uranai-stripe-sandbox-v2`（`FIREBASE_PROJECT_ID` と同じ） |
| `STRIPE_TEST_CHECKOUT` | `on` |
| `STRIPE_SECRET_KEY` | 個人事業主のアカウントの Sandbox の `sk_test_` |
| `STRIPE_WEBHOOK_SECRET` | 新しい送信先の `whsec_` |
| `STRIPE_ACCOUNT_ID` | 個人事業主のアカウントの `acct_`（**Preview 全体には登録しない**） |
| `SITE_STATUS` | `development` |
| `PAYMENT_PROVIDER` | `stripe` |
| `SESSION_SECRET`・`DATA_ENCRYPTION_KEY`・`CRON_SECRET` | 既存の Preview とは**別の値** |

登録しないもの：`STRIPE_LIVE_CHECKOUT`・`STRIPE_LIVE_OPERATOR_TEST`・`sk_live_` のキー・`STRIPE_API_BASE`・`FIRESTORE_EMULATOR_HOST`

登録の後、手元で形式を確かめられます（値は表示しない。ファイルは確認の後に削除する）：
`vercel env pull .env.preview.check --environment=preview --git-branch=<ブランチ>` → `npm run check:env -- --preview`

### 2.3 Stripe（個人事業主のアカウントの **Sandbox**）

- Sandbox に切り替えてから作業する（本番の画面では何も作らない）
- キー（`sk_test_`）を発行する。アカウントの ID（`acct_`）を確かめる
- Webhook の送信先を作る：
  - URL：新しいブランチの固定 URL の `/api/webhooks/stripe`（保護の回避の値をクエリに付ける。[preview-verification.md §1.6](preview-verification.md)）
  - API のバージョン：`2026-09-30.endive`
  - 通知：[preview-verification.md §1.4](preview-verification.md) の16種類
- 決済方法（カード・PayPay の可否）・Managed Payments の既定を確かめる

---

## 3. 作業の順序

1. ~~Firebase のプロジェクト ID を決める~~（`uranai-stripe-sandbox-v2`）→ §1 のコードの変更（済み）→ テスト（済み）→ commit・push（承認の後）
2. ~~Firebase のプロジェクトの作成~~（済み）→ サービスアカウントの鍵・rules・インデックス（§2.1）
3. 専用のブランチを作って push（初回のデプロイ。変数が無いので、決済を受け付けない安全な状態で動く）
4. Vercel のブランチ専用の変数（§2.2）→ Redeploy
5. Stripe の送信先（§2.3）→ `STRIPE_WEBHOOK_SECRET` を登録 → Redeploy
6. 読み取りの確認（§4）
7. 運営だけのテスト決済：決済・返金・異議申し立て（勝訴・敗訴）・PENDING の手動の再確認・Webhook の再処理

---

## 4. 確認項目（読み取りだけ）

- `/api/health`：Firebase の接続先の確認が ok、`paymentMode` が development
- 診断（`/api/ops/firebase-target`。診断用のトークンが必要）：5つの真偽値がすべて true
  （`projectIdIsPreview`・`productionProjectIdIsExpected`・`clientEmailBelongsToPreview`・`projectIdMatchesStripeTestProject`・`stripeAccountIdReady`）
- 運営画面の「設定」：決済モード・Webhook の URL
- 最初のテスト決済の決済画面が開けること（開けない・決済監視に「Stripe のキーが設定したアカウントのものか確認できない」が出たら、
  キーと `STRIPE_ACCOUNT_ID` の組み合わせを確かめる）
- 既存の Preview（`preview/stripe-verification`）の画面・決済監視が今までどおりであること

---

## 5. 注意

- 新しい検証環境の決済は Sandbox（`livemode=false`）なので、売上・店舗の精算に含めない
- Vercel の保護の回避の値はプロジェクトで共通。新しい送信先の URL にも同じ値が入るので、Stripe のダッシュボードを見られる人を限る
- 定期処理（PENDING の自動の回収・Webhook の自動の復旧）は Preview では動かない。運営画面の手動の操作で確かめる
- 既存の Preview の Firebase（`uranai-preview`）・旧 Sandbox・その送信先は変更しない（テストの履歴を残す）
