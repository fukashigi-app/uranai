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
| 決済 | PAY.JP（`PaymentProvider` で抽象化）/ 開発用 Mock | Stripe/Square へ差し替え可能 |
| バリデーション | zod | 全API・Server Action の入力検証 |
| QR | `qrcode` | サーバー側でPNG/SVG生成 |

外部Auth(Supabase Auth 等)を使わない理由: 「店舗は自店舗のみ」の認可を必ずサーバーで
`storeUsers` から解決する構造にしたく、ロジックを1か所に集約するため。

---

## 2. ディレクトリ構成

```
uranai/（リポジトリ直下）
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
│   │   │   ├─ webhooks/payjp/ … PAY.JP Webhook
│   │   │   ├─ webhooks/mock/  … 開発用Mock Webhook（本番では404）
│   │   │   ├─ store/qr/       … QR PNG ダウンロード（要店舗認証）
│   │   │   └─ cron/maintenance … 期限切れ処理・個人情報の定期削除
│   │   └─ terms / privacy / commercial-transaction
│   ├─ components/             … UI部品（星空背景・グラス カード・グラフ等）
│   └─ lib/
│       ├─ db/                 … schema.ts / client
│       ├─ auth/               … パスワード・セッション・認可ガード
│       ├─ payments/           … PaymentProvider 抽象 + payjp + mock + confirm(冪等計上)
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
| `PAYMENT_PROVIDER` | `payjp` / `mock`（`mock` は本番起動時に拒否） |
| `PAYJP_PUBLIC_KEY` | フロント用公開鍵（`pk_test_…`）※公開鍵のみフロントへ |
| `PAYJP_SECRET_KEY` | **サーバー専用**秘密鍵（`sk_test_…`） |
| `PAYJP_WEBHOOK_TOKEN` | PAY.JP管理画面のWebhookトークン（`X-Payjp-Webhook-Token` 検証） |
| `MOCK_WEBHOOK_SECRET` | Mock Webhook の HMAC 秘密鍵 |
| `PAYMENT_FEE_RATE_BPS` | 手数料率の既定値（PAY.JPは charge.fee_rate を優先） |
| `CRON_SECRET` | `/api/cron/maintenance` の Bearer トークン |
| `NEXT_PUBLIC_SITE_NAME` 等 | サービス名・テーマなどブランド設定 |

`PAYJP_SECRET_KEY` 等はすべて `server-only` モジュール（`src/lib/env.ts`）からのみ読み込み、
クライアントバンドルに混入するとビルドエラーになる。

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
[決済] /payment
  └ payjp.js v2 の Elements（カード番号はPAY.JPのiframe内、当社サーバーに来ない）
    createToken(…, {three_d_secure:true}) で 3Dセキュア認証 → tok_xxx
  └ POST /api/checkout/pay {cardToken}
       ・checkout を CREATED→PROCESSING に原子的更新（連打・二重課金防止）
       ・PAY.JP Charge 作成（amount=100, Idempotency-Key, metadata{checkoutId, storeId, fortuneType}）
       ・この時点では売上計上しない
  └ 画面「決済を確認しています…」→ GET /api/checkout/status をポーリング
[Webhook] POST /api/webhooks/payjp  (charge.succeeded)
       ・X-Payjp-Webhook-Token を定数時間比較で検証
       ・さらに PAY.JP API から Charge を取得し直して paid/captured/amount=100/jpy を確認
       ・confirmPayment(): 1トランザクションで
           transactions INSERT … ON CONFLICT DO NOTHING（UNIQUE で二重計上防止）
           store_share = floor(100 × 3000 / 10000) = 30円、operator_share = 70円、payment_fee = 100×fee_rate
           fortune_sessions INSERT（status=PAID, 24時間有効）
           checkouts → SUCCEEDED
  ※ Webhook遅延時は status API が一定時間後に同じ confirmPayment() を
    「PAY.JP APIからの取得結果」で実行（クライアント申告は一切信用しない）
[入力] /fortune/input → POST /api/fortune
       ・Cookieのトークンで fortune_session を特定、`UPDATE … WHERE status='PAID' AND expires_at>now()` で原子的に USED
       ・seed = hash(JST日付, 占い種別, 入力) で結果生成 → fortune_results 保存（生年月日は保存しない）
[結果] /fortune/result
       ・Cookieトークンに紐づく結果のみ表示。URLにIDを含まないため改ざん不可
       ・USED後24時間は同じ結果を再表示可能（通信断対策）
```

返金Webhook（`charge.refunded`）は transaction を `REFUNDED` にし、売上集計から除外する。

### PaymentProvider 抽象

```ts
interface PaymentProvider {
  id: 'payjp' | 'mock'
  createCharge(input): Promise<ChargeResult>            // サーバーのみ
  retrieveCharge(id): Promise<ProviderCharge>           // Webhook検証・照合
  parseWebhook(headers, rawBody): Promise<WebhookEvent> // 署名/トークン検証込み
}
```
Stripe 追加時は `stripe.ts` を実装し `PAYMENT_PROVIDER=stripe` にするだけ（confirmPayment は共通）。

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
