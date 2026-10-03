# 100円占い

飲食店・BAR・カフェのテーブルに置いたQRコードから、お客様が1回100円で占いを楽しめるWebサービス。
店舗別の売上計上（店舗30% / 運営70%）、店舗管理画面、運営管理画面、月次精算までを含みます。

設計の詳細（ディレクトリ構成・DB設計・認証方式・決済フロー）は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

## 技術構成

Next.js 16 (App Router) / TypeScript / Tailwind CSS v4 / **Cloud Firestore（Firebase Admin SDK）** または PostgreSQL + Drizzle ORM / PAY.JP（`PaymentProvider` で抽象化）

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
3. 自分のパソコンで運営アカウントを作成（秘密鍵はファイルに保存せず、その場の環境変数で渡す）
   ```bash
   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY="..." \
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='英数字10文字以上' npm run admin:create
   ```
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
npm test            # 単体テスト（配分計算・JST集計・占いの決定性・PAY.JP クライアント/Webhook検証）
npm run e2e         # 起動中のアプリに対し QR→100円決済→Webhook→占い→店舗30円計上 と認可を検証
```

## PAY.JP の設定（テスト環境 → 本番）

1. PAY.JP 管理画面で **テスト用** の公開鍵 `pk_test_…` / 秘密鍵 `sk_test_…` を取得
2. 管理画面 > Webhook に `https://<APP_URL>/api/webhooks/payjp` を登録し、表示される **Webhookトークン** を控える
3. 環境変数を設定
   ```
   PAYMENT_PROVIDER=payjp
   PAYJP_PUBLIC_KEY=pk_test_...
   PAYJP_SECRET_KEY=sk_test_...      # サーバー専用。フロントには絶対に置かない
   PAYJP_WEBHOOK_TOKEN=whook_...
   ```
4. テストカードで「QR → 決済 → 占い → 店舗売上30円」を確認後、本番鍵 `pk_live_` / `sk_live_` に差し替え

> ⚠️ この実装はサンドボックス環境（PAY.JPへの通信不可）で作成したため、PAY.JP の実API・payjp.js に対する
> 疎通確認は未実施です（リクエスト形式・Webhookトークン検証は fetch をモックした単体テストで確認済み）。
> 本番前に必ずテストモードで以下を確認してください:
> - payjp.js v2 の `createToken(element, { three_d_secure: true })` による 3Dセキュア認証の挙動
> - 3Dセキュアで求められるメールアドレス/電話番号の扱い（現在はメール任意入力。保存はしない）
> - Webhook イベント（`charge.succeeded` / `charge.refunded`）の受信と `X-Payjp-Webhook-Token` の一致

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
3. **月次精算**: 翌月に 運営画面 > 月次精算 で対象月を選び「集計して精算を作成」
   → 振込用CSVで振込 → 各行を「処理中」「支払済」に変更（店舗画面の「振込状況」に反映）
4. **QR再発行**: 紛失・悪用時は店舗詳細から再発行（旧QRは即無効）
5. **店舗停止**: 店舗詳細から停止すると新規決済を受け付けません（既存の売上・権利はそのまま）

## ブランド変更

- サービス名・キャッチコピー・運営者情報: `NEXT_PUBLIC_*` 環境変数 または `src/config/site.ts`
- テーマカラー: `src/app/globals.css` の `:root` の CSS 変数
- ロゴ / ファビコン / OGP: `public/logo.svg`・`src/app/icon.svg`・`public/og.png`
- 占い文章: `src/lib/fortune/templates.ts`（配列は末尾に追加すると既存の結果が変わりません）

## セキュリティ要点

- 金額はサーバー固定（`src/config/pricing.ts`）。API はクライアントから金額・storeId を受け付けない
- 売上計上は Webhook（トークン検証）＋決済代行APIからの Charge 再取得でのみ行い、`UNIQUE(provider, provider_payment_id)` で二重計上を防止
- 占い権利・結果は HttpOnly Cookie のトークン（DBはハッシュ）で紐付け、URLにIDを含めない
- 店舗画面の storeId は常にセッションから解決。運営画面は OPERATOR 以外 404
- パスワード scrypt、ログインのRate Limit + アカウントロック、`__Host-` Secure Cookie
- CSRF: Server Actions の Origin 検証 + 独自APIの Origin 検証 + SameSite=Lax
- CSP / HSTS / X-Frame-Options 等をヘッダーで付与。口座情報は AES-256-GCM 暗号化、閲覧・変更は監査ログに記録
- カード情報は payjp.js（PAY.JP の iframe）でのみ扱い、自社サーバー・DBには保存しない
- 生年月日はDBに保存しない（占いの seed 計算にのみ使用）
