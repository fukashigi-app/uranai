# 100円占い

飲食店・BAR・カフェのテーブルに置いたQRコードから、お客様が1回100円で占いを楽しめるWebサービス。
店舗別の売上計上（店舗30% / 運営70%）、店舗管理画面、運営管理画面、月次精算までを含みます。

設計の詳細（ディレクトリ構成・DB設計・認証方式・決済フロー）は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

## 技術構成

Next.js 16 (App Router) / TypeScript / Tailwind CSS v4 / PostgreSQL + Drizzle ORM / PAY.JP（`PaymentProvider` で抽象化）

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

`ENABLE_TEST_PAYMENT=true` のときだけ有効になります（Vercel でも同じ）。

- トップ `/` からそのまま占いを選べます（QRなしの場合は「テスト店舗（動作確認用）」が自動で使われます）
- `/test` を開くとテスト店舗を選んだ状態で占い選択に進みます
- お支払い画面は「テスト決済で進む（無料）」ボタンのみ。実際の請求は発生しません
- 画面上部に「テストモード」と表示されます。テスト決済は店舗への振込（月次精算）の対象外です

`ENABLE_TEST_PAYMENT=false`（または未設定）にすると、テスト決済・テスト店舗・`/test` はすべて使えなくなり、
本番決済（`PAYMENT_PROVIDER`）が必須になります。本番決済が未設定の場合は「ただいまお支払いを受け付けていません」と表示され、
無料で占いが使われることはありません。設定状況は `/api/health` で確認できます（秘密情報は表示しません）。

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
