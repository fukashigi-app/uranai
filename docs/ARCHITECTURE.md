# 100円占い — システム設計書

QRコード → 100円決済 → Webhook確認 → 占い → 店舗売上計上（30%）までを
すべてサーバーサイドで安全に処理する、複数店舗展開前提の占いWebサービス。

---

## 1. 技術構成

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| フレームワーク | Next.js 16 (App Router) + TypeScript | ページ・API・Server Actions を1リポジトリで。Vercel にそのままデプロイ可能 |
| スタイル | Tailwind CSS v4 + CSS変数テーマ | テーマカラーを `globals.css` の変数だけで差し替え可能 |
| DB | PostgreSQL (Supabase / Neon / RDS 等どれでも可) | 制約・トランザクション・UNIQUE によるidempotency |
| ORM | Drizzle ORM + node-postgres | 型安全、SQLに近く、プリペアドステートメントでSQLインジェクションを防止 |
| 認証 | 自前のDBセッション（scrypt + HttpOnly Cookie） | 外部Authに依存せず、店舗/運営のロール分離をサーバーで完結 |
| 決済 | Stripe Checkout（`lib/payments/stripe-*.ts`）/ 自動テスト用の疑似決済 Mock | PAY.JP は廃止（コード・Webhook・カード入力フォームを削除） |
| バリデーション | zod | 全API・Server Action の入力検証 |
| QR | `qrcode` | サーバー側でPNG/SVG生成 |

外部Auth(Supabase Auth 等)を使わない理由: 「店舗は自店舗のみ」の認可を必ずサーバーで
`storeUsers` から解決する構造にしたく、ロジックを1か所に集約するため。

---

## 2. ディレクトリ構成

```
uranai/ (リポジトリルート)
├─ docs/ARCHITECTURE.md        … 本書
├─ drizzle/                    … SQLマイグレーション（drizzle-kit 生成）
├─ scripts/
│   ├─ migrate.ts              … マイグレーション適用
│   ├─ seed.ts                 … 開発用デモデータ（運営・店舗・スタッフ）
│   ├─ create-admin.ts         … 本番用運営アカウント作成
│   └─ e2e-flow.ts             … QR→決済→Webhook→占い→30円計上 のE2E検証
├─ src/
│   ├─ proxy.ts                … 楽観的ログインリダイレクト / QR店舗Cookie
│   ├─ config/
│   │   ├─ site.ts             … サービス名・ロゴ・OGP・運営者情報（環境変数で上書き可）
│   │   └─ pricing.ts          … 価格(100円)・配分率(30%)・手数料率 ※サーバー専用
│   ├─ app/
│   │   ├─ s/[storeCode]/      … QR着地 = 店舗専用トップ
│   │   ├─ fortune/            … 占い選択 / input / result
│   │   ├─ payment/            … 決済画面
│   │   ├─ store/              … 店舗管理（login + (portal)/…）
│   │   ├─ admin/              … 運営管理（login + (console)/…）
│   │   ├─ api/
│   │   │   ├─ checkout/       … 決済セッション作成 / 支払い / 状態確認
│   │   │   ├─ fortune/        … 占い実行
│   │   │   ├─ webhooks/stripe/ … Stripe Webhook（署名・livemode を確認）
│   │   │   ├─ webhooks/mock/  … 自動テスト用の疑似決済の Webhook（PAYMENT_PROVIDER=mock 以外では404）
│   │   │   ├─ store/qr/       … QR PNG ダウンロード（要店舗認証）
│   │   │   └─ cron/maintenance … 期限切れ処理・個人情報の定期削除
│   │   └─ terms / privacy / commercial-transaction
│   ├─ components/             … UI部品（星空背景・グラス カード・グラフ等）
│   └─ lib/
│       ├─ db/                 … schema.ts / client
│       ├─ auth/               … パスワード・セッション・認可ガード
│       ├─ payments/           … Stripe（Checkout・照合・返金・異議申し立て・精算の調整の規則）+ 疑似決済 mock（自動テスト専用）
│       ├─ fortune/            … seed RNG・テンプレート・エンジン(将来AIに差替え可)
│       ├─ security/           … 暗号化(AES-GCM)・Rate Limit・Origin検証
│       ├─ services/           … 集計・精算・店舗管理などのドメインロジック
│       └─ money.ts / time.ts  … 整数円計算・JST日付
```

---

## 3. DB設計

金額はすべて **integer（円）**。率は **basis points（1% = 100bps）** の integer。
日時は `timestamptz`、集計は `Asia/Tokyo` で日/月を切る。

| テーブル | 主な列 | 制約・INDEX |
| --- | --- | --- |
| `users` | id, email, password_hash, name, role(`OPERATOR`/`STORE`), is_active, failed_login_count, locked_until, last_login_at | UNIQUE(lower(email)) |
| `auth_sessions` | id(=sha256(token)), user_id, expires_at | FK users, INDEX(user_id) |
| `stores` | id, store_code, name, contact_name, postal_code, address, phone, email, status(`ACTIVE`/`SUSPENDED`), store_share_bps(既定3000), bank_info_encrypted, bank_account_last4, bank_updated_at | UNIQUE(store_code), INDEX(status) |
| `store_users` | user_id, store_id, role | UNIQUE(user_id, store_id), FK |
| `checkouts` | id, store_id, fortune_type, amount, status, provider, provider_payment_id, access_token_hash, attempt_count, failure_code, expires_at | UNIQUE(provider, provider_payment_id), UNIQUE(access_token_hash) |
| `transactions` | id, checkout_id, payment_provider, provider_payment_id, store_id, fortune_type, amount, store_share, operator_share, payment_fee, store_share_bps, payment_status(`SUCCEEDED`/`REFUNDED`), fortune_status(`PENDING`/`COMPLETED`/`EXPIRED`), paid_at, created_at | **UNIQUE(payment_provider, provider_payment_id)**, UNIQUE(checkout_id), INDEX(store_id, paid_at), CHECK(store_share+operator_share=amount) |
| `fortune_sessions` | id, transaction_id, store_id, fortune_type, token_hash, status(`PAID`/`USED`/`EXPIRED`), expires_at, used_at | UNIQUE(transaction_id), UNIQUE(token_hash) |
| `fortune_results` | id, fortune_session_id, store_id, fortune_type, engine, result(jsonb), viewable_until | UNIQUE(fortune_session_id) |
| `settlements` | id, store_id, year_month, transaction_count, gross_sales, store_share, status(`UNPAID`/`PROCESSING`/`PAID`), paid_at, note | UNIQUE(store_id, year_month) |
| `webhook_events` | provider, event_id, type, processed_at | UNIQUE(provider, event_id) |
| `audit_logs` | actor_user_id, action, target_type, target_id, store_id, before(jsonb), after(jsonb) | INDEX(store_id, created_at) |
| `rate_limits` | key, window_start, count | PK(key, window_start) |

- `checkouts` は「決済前の注文」。仕様の `sessionId` に相当し、決済メタデータに入る。
- 生年月日は **DBに保存しない**（占い生成時のseedにのみ使用）。`fortune_results` には結果文面のみ。
- 口座情報は AES-256-GCM で暗号化し `bank_info_encrypted` に保存。画面には下4桁のみ。
- 店舗情報・口座の変更履歴は `audit_logs`（口座はマスク済みの値のみ記録）。

---

## 4. 環境変数（`.env.example` 参照）

| 変数 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL接続文字列 |
| `APP_URL` | 公開URL（QRのURL生成・Origin検証） |
| `SESSION_SECRET` | Cookie署名用（32byte以上の乱数） |
| `DATA_ENCRYPTION_KEY` | 口座情報暗号化キー（base64 32byte） |
| `PAYMENT_PROVIDER` | `stripe`（一般のお客さんの決済を Stripe Checkout で受け付ける）/ `mock`（自動テスト専用。Vercel の本番では無効）。`payjp` は廃止（設定なしとして扱い警告） |
| `STRIPE_TEST_CHECKOUT` | `on` で Stripe のテスト決済（Sandbox）を有効にする（Preview・ローカルだけ） |
| `STRIPE_SECRET_KEY` | **サーバー専用**の Stripe の秘密鍵（テストは `sk_test_`。本番用 `sk_live_` はテストの環境では拒否） |
| `STRIPE_WEBHOOK_SECRET` | Stripe の Webhook の署名の値（`whsec_`） |
| `STRIPE_TEST_FIREBASE_PROJECT_ID` | テスト決済を使う Firebase プロジェクト（本番のIDとは別であること） |
| `STRIPE_LIVE_CHECKOUT` / `STRIPE_LIVE_OPERATOR_TEST` | 本番決済の判定だけ（本番決済は未実装・無効） |
| `MOCK_WEBHOOK_SECRET` | 疑似決済の Webhook の HMAC 秘密鍵（自動テスト用） |
| `PAYMENT_FEE_RATE_BPS` | 決済手数料率の推定値（Stripe の手数料が確定したら確定値に更新。手数料は運営の負担） |
| `CRON_SECRET` | `/api/cron/maintenance` の Bearer トークン |
| `NEXT_PUBLIC_SITE_NAME` 等 | サービス名・テーマなどブランド設定 |

`STRIPE_SECRET_KEY` 等はすべて `server-only` モジュールからのみ読み込み、クライアントバンドルに混入するとビルドエラーになる。
`PAYJP_*` は読まない（残っていれば設定の確認で削除を促す）。

---

## 5. 認証・認可

- パスワード: `scrypt`(N=2^15) + ランダムsalt。比較は `timingSafeEqual`。
- ログイン5回失敗で15分ロック + IP単位Rate Limit。
- セッション: 32byte乱数トークンを Cookie（`HttpOnly; Secure; SameSite=Lax; Path=/`、本番は `__Host-` 接頭辞）、
  DBには `sha256(token)` のみ保存（DB漏洩時にもセッションを乗っ取れない）。
- 店舗ページ: `requireStoreUser()` が `auth_sessions → users → store_users` から **サーバー側で storeId を解決**。
  店舗ページのURLには storeId を一切含めないため、パラメータ改ざんで他店舗を見ることは構造的に不可能。
- 運営ページ: `requireOperator()`（role=`OPERATOR`）。店舗アカウントは 404 扱い。
- `proxy.ts` は Cookie 有無だけを見る楽観的リダイレクト（UX用）。本当の認可は各ページ/Actionで毎回実施。
- CSRF: Server Actions は Next.js の Origin/Host 検証 + SameSite=Lax。
  独自 API Route(POST) は `assertSameOrigin()` で Origin ヘッダを検証。Webhookのみ除外（署名で検証）。

---

## 6. 決済フロー

```
[QR] /s/{storeCode}
  └ サーバーで店舗をDB照会（停止中なら案内表示）→ Cookie `qr_store`=storeCode を保存
[選択] /fortune でカード選択 →「この占いを100円で始める」
  └ POST /api/checkout {fortuneType}
       ・Cookieの storeCode を **DBで再照会**、ACTIVEでなければ拒否
       ・金額はサーバーの `PRICE_JPY=100` を使用（クライアント値は受け取らない）
       ・checkouts 作成、32byteアクセストークンを HttpOnly Cookie `fx_access` に発行（DBはハッシュ）
[決済] /payment（購入前の確認事項を表示）
  └ POST /api/checkout/stripe-session
       ・注文（Cookie）と Stripe の Checkout Session を紐付け（金額100円・店舗・注文IDを metadata に入れる。
         支払い方法はカード・PayPay に絞る。同じ注文では同じ Session を使い、何度押しても増えない）
       ・お客さんを Stripe の決済画面へ移動（カード情報は Stripe のページだけで扱い、当社サーバーに来ない）
[戻り先] /payment/return?session_id=… ／ [Webhook] POST /api/webhooks/stripe
       ・Webhook は署名（STRIPE_WEBHOOK_SECRET）と livemode を確認。通知の中身は信用しない
       ・どちらも Stripe API から Session・PaymentIntent・Charge を取り直し、注文・金額・店舗・支払い方法を照合
       ・確定（1トランザクション。Webhook と戻り先が同時でも1件）:
           transactions/stripe_{PaymentIntent} 作成（store_share = 30円・operator_share = 70円・手数料は確定値または推定値）
           fortune_sessions 作成（status=PAID, 24時間有効）・checkouts → SUCCEEDED
       ・PayPay などの確定待ちは、確定の通知か照合で確定するまで権利を付与しない
[入力] /fortune/input → POST /api/fortune
       ・Cookieのトークンで fortune_session を特定、`UPDATE … WHERE status='PAID' AND expires_at>now()` で原子的に USED
       ・seed = hash(JST日付, 占い種別, 入力) で結果生成 → fortune_results 保存（生年月日は保存しない）
[結果] /fortune/result
       ・Cookieトークンに紐づく結果のみ表示。URLにIDを含まないため改ざん不可
       ・USED後24時間は同じ結果を再表示可能（通信断対策）
```

### 返金・異議申し立て・精算の調整

- 返金（`charge.refunded`・`refund.*`）・異議申し立て（`charge.dispute.*`）は、Stripe API で状態を取り直し、記録と照合してから反映する。
  処理中・失敗の返金は売上を減らさない。全額の返金・敗訴は売上から除き、一部返金・一部の額の敗訴は残りの金額で集計する
- 精算を確定（処理中・支払済）すると、その月の取引に「支払った額」を記録する。その後の返金・異議申し立ては
  `settlementAdjustments`（調整）として記録し、次に確定する精算で差し引く（振込額を超える分は繰越）。過去の取引・支払済みの精算は書き換えない
- 記録と照合できない通知・以前の仕組みで確定した精算の変化は `paymentReviews`（決済要確認）に記録し、運営が確認する

### Stripe の Webhook に登録するイベント

`checkout.session.completed` / `checkout.session.async_payment_succeeded` / `checkout.session.async_payment_failed` / `checkout.session.expired` /
`charge.refunded` / `charge.refund.updated` / `refund.created` / `refund.updated` / `refund.failed` /
`charge.dispute.created` / `charge.dispute.updated` / `charge.dispute.closed` / `charge.dispute.funds_withdrawn` / `charge.dispute.funds_reinstated` /
`charge.updated` / `charge.succeeded`（手数料の確定）

### 疑似決済（自動テスト専用）

`PAYMENT_PROVIDER=mock` のときだけ `/api/checkout/pay`・`/api/webhooks/mock` と疑似決済の画面（`mock-payment-form.tsx`）が使える。
それ以外（Stripe・未設定・Vercel の本番）では 404・表示なし。疑似決済は売上の画面には数えるが（自動テスト環境だけ）、精算には決して含めない。

### 過去の PAY.JP の記録

`paymentProvider: "payjp"` の記録は削除・変更しない。集計・精算・管理画面は `paymentProvider` と `livemode` から種類を判定して読む
（外部の API には問い合わせない）。PAY.JP の注文が残っていても、決済の画面は出さない。

---

## 7. 占いロジック

- `seed = FNV-1a(JST日付 | type | 正規化入力)` → `mulberry32` 擬似乱数。`Math.random()` は不使用。
- 同一人物・同一日・同一条件 → 同一結果。
- `FortuneEngine` インターフェース（`template-v1`）。将来 `ai-v1` を同じIFで追加可能。

## 8. 精算

- 月次集計（JST）で `settlements` を UPSERT。`PROCESSING`/`PAID` の行は上書きしない。
- 運営が振込後に「支払済」へ変更（`paid_at` 記録・監査ログ）。店舗側は閲覧のみ。

## 9. プライバシー

- 利用者の氏名・メール・電話・住所は収集しない。生年月日はDB非保存。
- `fortune_results` は30日後に定期削除、未使用 `checkouts` は7日後に削除（`/api/cron/maintenance`）。
- アクセスログ/アプリログに入力値・トークンを出力しない。
