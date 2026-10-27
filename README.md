# 100円占い

飲食店・BAR・カフェのテーブルに置いたQRコードから、お客様が1回100円で占いを楽しめるWebサービス。
店舗別の売上計上（店舗30% / 運営70%）、店舗管理画面、運営管理画面、月次精算までを含みます。

設計の詳細（ディレクトリ構成・DB設計・認証方式・決済フロー）は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

## 技術構成

Next.js 16 (App Router) / TypeScript / Tailwind CSS v4 / **Cloud Firestore（Firebase Admin SDK）** または PostgreSQL + Drizzle ORM / **Stripe Checkout**（決済。PAY.JP は廃止。自動テスト用の疑似決済 `mock` だけ `PaymentProvider` で抽象化）

## データベース（Cloud Firestore へ移行中）

保存先は環境変数で自動的に切り替わります（`src/lib/data-provider.ts`）。

| 設定 | 使われる保存先 |
| --- | --- |
| `FIREBASE_PROJECT_ID`（＋ `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`）あり | **Cloud Firestore** |
| 上記なし | PostgreSQL（`DATABASE_URL`。移行確認後に削除予定） |

- Firestore へは **Vercel 上のサーバーから Firebase Admin SDK でのみ**アクセスします。`firestore.rules` でブラウザからの読み書きは全面禁止です（Firebase Console の「ルール」に同じ内容を設定してください）。
- 店舗ごとの閲覧制限は、これまでどおりサーバー側のコードで行います。
- 二重計上防止: `transactions` のドキュメントIDを「決済会社_決済ID」にし、トランザクション内で存在確認します。
- 集計はすべて「1つの等価条件」の検索なので、**複合インデックスの作成は不要**です。
- コレクション: `users` `userEmails` `authSessions` `stores` `storeCodes` `storeUsers` `checkouts` `transactions` `fortuneSessions` `fortuneResults` `settlements` `webhookEvents` `auditLogs` `testFortuneLogs` `rateLimits`

### Firestore Emulator でのテスト（本番に触れない）

```bash
npm run emulator                       # 別ターミナルで起動（Java が必要）
npm run build
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai PAYMENT_PROVIDER=mock \
  ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=true ENABLE_TEST_PAYMENT=true npx next start   # 別ターミナル
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai PAYMENT_PROVIDER=mock npm run e2e:firestore
```

### 本番 Firestore の初期設定

1. Vercel の環境変数に `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` / `SESSION_SECRET` / `DATA_ENCRYPTION_KEY` を登録し、Redeploy
2. `https://<公開URL>/api/health` で `"dataProvider":"firestore"` と `"database":"ok"` を確認
3. ブラウザで `https://<公開URL>/admin/setup` を開き、最初の運営アカウントを作成（メールアドレスとパスワードを入力）
   - 運営アカウントが1件も無いときだけ使え、作成後は永久に無効になります（以後は「初期設定は完了しています」と表示）
   - 任意で Vercel の環境変数 `ADMIN_SETUP_TOKEN` を設定すると、その値（セットアップキー）を知っている人だけが作成できます
   - パスワードは既存ルール（10文字以上・英字と数字）。scrypt ハッシュのみ保存
   - 従来どおりパソコンから `npm run admin:create` で作成することもできます
4. 運営画面（`/admin/login`）から店舗と店舗アカウントを作成

## ローカル開発

```bash
git clone https://github.com/fukashigi-app/uranai.git && cd uranai
npm install
cp .env.example .env          # DATA_ENCRYPTION_KEY / SESSION_SECRET / CRON_SECRET を生成して設定
npm run db:migrate            # マイグレーション適用
npm run db:seed               # デモ店舗・運営/店舗アカウント・過去実績を作成（開発用）
npm run dev
```

seed 後に表示されるQR URL（`/s/xxxxxxxxxxxx`）をスマホ幅で開くと利用者フローを試せます。

| 画面 | URL | デモアカウント |
| --- | --- | --- |
| 利用者 | `/s/{storeCode}` | 不要 |
| 店舗管理 | `/store/login` | store@example.com / StorePass2026 |
| 運営管理 | `/admin/login` | admin@example.com / AdminPass2026 |

## テストモード（決済なしで動作確認）

`ENABLE_TEST_PAYMENT=true` のときだけ有効になります（コード内には固定していません）。

- トップ `/` または `/s/test`（テスト店舗）から開始。占いを選ぶと「テストモード：無料で占う」ボタンが表示され、決済をスキップして入力画面へ進みます
- 占いの状態はブラウザの署名付きCookieに保存するため、**データベース未接続でも最後まで動作**します（再読み込みしても続きから再開）
- 売上・決済のテーブル（transactions / checkouts / fortune_sessions）には**一切記録しません**。本番の売上100円・店舗報酬30円・運営70円には混入しません
- テスト利用は `test_fortune_logs` テーブル（店舗コード・占い種類・日時のみ）に記録されます（DBがある場合）
- 画面上部に「現在テストモードのため決済は発生しません」と表示されます

`ENABLE_TEST_PAYMENT=false`（または未設定）にすると、テスト用の入口・ボタン・Cookie はすべて無効になり、
決済成功の確認なしでは占えなくなります（決済が未設定の場合は「ただいまお支払いを受け付けていません」と表示）。
設定状況は `/api/health` で確認できます（秘密情報は表示しません）。

## テスト

```bash
npm run typecheck   # 型チェック
npm run lint
npm test            # 単体テスト（配分計算・JST集計・占いの決定性・Stripe の照合・精算の調整の規則・設定の安全確認）
npm run e2e         # 起動中のアプリ（疑似決済）に対し QR→100円決済→Webhook→占い→店舗30円計上 と認可を検証
```

Stripe の E2E は、Firestore Emulator の `demo-` プロジェクトと、スクリプトが起動する localhost の模擬 Stripe API だけを使います（本物の Stripe・本番の Firebase には接続しません）。
`npm run e2e:stripe`（運営の Sandbox テスト）・`e2e:stripe-public`（一般のお客さん）・`e2e:stripe-live`（本番モードの照合）・
`e2e:stripe-settlement`（返金・異議申し立て・精算の調整）・`e2e:stripe-settlement-safety`（以前の精算・決済要確認・確定の順番など）。

## 決済（Stripe Checkout）

決済は Stripe Checkout だけです（PAY.JP は廃止しました。PAY.JP のコード・Webhook・カード入力フォームは削除済みで、`PAYJP_*` の環境変数は読みません）。
お客さんは「同意して100円を支払う」ボタンで Stripe の決済画面に移動し、クレジットカード（Apple Pay・Google Pay を含む）または PayPay で支払います。
支払いの確定は、Stripe API で Session・PaymentIntent・Charge を取り直して照合してから記録します（Webhook と戻り先のどちらでも、記録は1件）。

- **テスト決済（Sandbox）**：Vercel の Preview・ローカルだけ。`STRIPE_TEST_CHECKOUT=on`・`STRIPE_SECRET_KEY`（`sk_test_`）・`STRIPE_WEBHOOK_SECRET`・
  `STRIPE_TEST_FIREBASE_PROJECT_ID` がそろったときだけ有効。運営アカウントは `/fortune?pay=stripe-test` から、
  一般のお客さんは公開中（`SITE_STATUS=open`）かつ `PAYMENT_PROVIDER=stripe` のときに使えます。テスト決済は売上・精算に含めません
- **本番決済（Live）**：未実装・無効です（`STRIPE_LIVE_CHECKOUT` の判定だけがあり、決済の処理からは使っていません）
- Webhook の URL は `https://<APP_URL>/api/webhooks/stripe`。必要なイベントは `docs/ARCHITECTURE.md` を参照
- 返金・異議申し立て（チャージバック）は Stripe API で状態を取り直して反映し、振込済みの月の取引は「精算の調整」として次回の精算で差し引きます
- 記録と照合できない通知（店舗・金額の食い違いなど）は反映せず、運営画面の「決済要確認」に記録します

## デプロイ（例: Vercel + Supabase / Neon）

1. PostgreSQL を用意し `DATABASE_URL` を設定（マネージドDBは `?sslmode=require`）
2. Vercel でこのリポジトリをインポートし（Root Directory は空欄＝リポジトリ直下、Framework Preset は Next.js）、`.env.example` の変数をすべて登録（`APP_URL` は https）
3. マイグレーションは Vercel のビルド時（`vercel-build`）に自動適用されます（手動なら `npm run db:migrate`）
4. 運営アカウントを作成
   ```bash
   ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='強いパスワード123' npm run admin:create
   ```
5. `vercel.json` の Cron が `/api/cron/maintenance` を毎日 03:17（JST）に実行（`CRON_SECRET` を設定。Hobby プランは1日1回まで）。
   期限切れ処理と、占い結果30日・未決済注文7日の自動削除を行います。

## 運用フロー

1. **店舗追加**: 運営画面 > 店舗 > 店舗を追加（店舗ログインアカウントも同時作成可）
2. **QR発行**: 店舗詳細 / 店舗画面の「店舗QRコード」から PNG 保存・A4印刷用POP（A6×4面）
3. **月次精算**: 翌月に 運営画面 > 月次精算 で対象月を選び「集計して精算を作成」。振込は原則3か月ごとにまとめて行う
   → 同じ店舗は古い月から「処理中」「支払済」にして確定（未反映の調整を合わせて振込額が決まる。確定後は未払いに戻せない）
   → 振込用CSV（振込額・調整・繰越）で振込（店舗画面の「振込状況」に反映）
4. **決済要確認**: 運営画面 > 決済要確認 で、照合できなかった Stripe の通知・以前に確定した精算の変化を確認し「確認済みにする」
5. **QR再発行**: 紛失・悪用時は店舗詳細から再発行（旧QRは即無効）
6. **店舗停止**: 店舗詳細から停止すると新規決済を受け付けません（既存の売上・権利はそのまま）

## ブランド変更

- サービス名・キャッチコピー・運営者情報: `NEXT_PUBLIC_*` 環境変数 または `src/config/site.ts`
- テーマカラー: `src/app/globals.css` の `:root` の CSS 変数
- ロゴ / ファビコン / OGP: `public/logo.svg`・`src/app/icon.svg`・`public/og.png`
- 占い文章: `src/lib/fortune/templates.ts`（配列は末尾に追加すると既存の結果が変わりません）

## セキュリティ要点

- 金額はサーバー固定（`src/config/pricing.ts`）。API はクライアントから金額・storeId を受け付けない
- 売上計上は Stripe の Webhook（署名と livemode の確認）または戻り先で、Stripe API から取り直した Session・PaymentIntent・Charge を注文と照合してから行い、取引のIDを決済ごとに決めて二重計上を防止
- 占い権利・結果は HttpOnly Cookie のトークン（DBはハッシュ）で紐付け、URLにIDを含めない
- 店舗画面の storeId は常にセッションから解決。運営画面は OPERATOR 以外 404
- パスワード scrypt、ログインのRate Limit + アカウントロック、`__Host-` Secure Cookie
- CSRF: Server Actions の Origin 検証 + 独自APIの Origin 検証 + SameSite=Lax
- CSP / HSTS / X-Frame-Options 等をヘッダーで付与。口座情報は AES-256-GCM 暗号化、閲覧・変更は監査ログに記録
- カード情報は Stripe の決済画面（Stripe Checkout）でのみ扱い、自社サーバー・DBには送信・保存しない（このサイトに外部のスクリプト・iframe は読み込まない。CSP で禁止）
- 生年月日はDBに保存しない（占いの seed 計算にのみ使用）
<!-- Trigger Build Check for PR #3 -->
