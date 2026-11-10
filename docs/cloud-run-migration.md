# Cloud Run 移行の設定と手順（準備段階）

Vercel（Hobby プラン）から Google Cloud Run（`asia-northeast1`）へ移すための、コード側の設定と手順をまとめます。
この文書には環境変数の**名前だけ**を書きます。値（秘密鍵・キー・トークン・Webhook の署名の秘密）は書かないでください。

> **現在の状態**：コードの準備（下の §1 の設定）はローカルで実装・単体テスト済みです。
> Google Cloud の課金登録・Cloud Run へのデプロイはまだ行っていないため、**Cloud Run の実環境での動作はすべて「未検証」**です。
> 「未検証」と書いた項目は、Sandbox で確かめるまで正しいと扱わないでください。
> 既存の Vercel（Production・Preview）の動作は変えていません（§1 の変数は Vercel では設定しない）。

---

## 1. Cloud Run 用の環境変数（Vercel では設定しない）

6つとも、**未設定なら従来（Vercel 向け）の動作**です。想定外の値は、黙って従来の動作に戻さず停止します（fail-closed）。

| 変数 | 用途 | 設定する環境 | 有効になる条件 | 誤設定のときの影響 |
| --- | --- | --- | --- | --- |
| `FIREBASE_CREDENTIALS` | Firestore の認証を、秘密鍵ではなく Cloud Run の実行用サービスアカウント（Application Default Credentials）にする | Cloud Run の**本番**だけ（Sandbox では使えない。§4） | 値が `application-default`。`FIREBASE_PROJECT_ID` 必須、`FIREBASE_CLIENT_EMAIL`・`FIREBASE_PRIVATE_KEY` は**登録しない** | 想定外の値・`FIREBASE_PROJECT_ID` の欠落・秘密鍵の残り → Firestore に接続しない（`/api/health` の `database` が error、運営の詳細表示に `FIREBASE_CREDENTIALS` の状態）。接続先の確認（本番・Preview の分離）は従来どおり先に行う |
| `CLIENT_IP_SOURCE` | レート制限に使う送信元 IP の判定を Cloud Run 用にする | Cloud Run（Sandbox で位置を確かめた後） | 値が `x-forwarded-for-from-right`。`X-Real-IP` は使わず、`X-Forwarded-For` を右から数えた位置だけを使う | 想定外の値 → 注文・決済・ログインの API が停止（500。レート制限を素通りさせない）、無料の占いは 503 |
| `CLIENT_IP_XFF_POSITION_FROM_RIGHT` | 上の方式で信頼する位置（1 = 末尾） | Cloud Run（`CLIENT_IP_SOURCE` と一緒） | `1`〜`5` の数字 | 未設定・範囲外・数字以外 → 上と同じく停止。**形は正しいが位置が違う**場合はコードで検出できない（§6） |
| `TRUSTED_ORIGIN_SOURCE` | 自サイトのオリジンの基準を `APP_URL` だけにする（`Host`・`X-Forwarded-Host`・`X-Forwarded-Proto` を信頼しない） | Cloud Run（Sandbox・本番の両方） | 値が `app-url`。`APP_URL` は https の絶対 URL（パス・クエリ・ユーザー名なし。末尾の `/` は可）で、アプリが使う公開 URL と同じオリジン | 想定外の値・`APP_URL` の不正 → 注文・決済・管理の API と結果ページが停止（500）。拒否側に倒れる |
| `CLIENT_IP_DIAGNOSTICS` | 【一時的】送信元 IP のヘッダーの構造の診断（`GET /api/ops/client-ip`）を有効にする | Cloud Run の **Sandbox だけ**。確認後に削除（§10） | 値が `on`、かつ §5.1 の条件をすべて満たす | 条件を満たさなければ 404（存在も示さない）。本番では有効にならない |
| `CLIENT_IP_DIAGNOSTICS_TOKEN` | 【一時的】診断の追加の認証（`Authorization: Bearer` または専用ヘッダー `x-client-ip-diagnostics-token` のどちらか一方で送る） | Cloud Run の Sandbox だけ | 32文字以上 | 短い・未設定 → 診断は無効（404）。**値は文書・チャット・ログに書かない** |

`.env.example` にも同じ説明を、値なし・コメントのままで載せています（コピーしても何も有効にならない）。

設定の確認：運営アカウントで `/api/health` を開くと、`CLIENT_IP_SOURCE`・`TRUSTED_ORIGIN_SOURCE` の状態を「未設定」「有効」「設定の誤り」の3種類で表示します（位置・`APP_URL` の値は表示しない）。
`CLIENT_IP_SOURCE` は `CLIENT_IP_XFF_POSITION_FROM_RIGHT` との組み合わせ（位置だけ残っているのも誤り）、`TRUSTED_ORIGIN_SOURCE` は `APP_URL` の形式も確かめます。
「設定の誤り」のときは `ok=false`（503）になります。認証なしの `/api/health` の応答は変わりません。

---

## 2. Vercel Preview と Cloud Run Sandbox の違い

| 項目 | Vercel Preview | Cloud Run Sandbox |
| --- | --- | --- |
| `VERCEL_ENV`・`VERCEL_GIT_COMMIT_REF` | Vercel が自動で渡す | **手動で設定**（`preview`・`preview/stripe-sandbox-v2`。接続先の確認と Stripe のテスト決済の条件に使う） |
| `APP_URL` | 未設定なら Vercel の URL を自動で使う | **必須**（§8）。未設定だと `http://localhost:3000` になる |
| 送信元 IP・`Host` 系のヘッダー | Vercel が上書きする | Google が上書きするか**未検証**（§5）。`TRUSTED_ORIGIN_SOURCE=app-url` を設定する |
| ビルド時の環境変数 | 実行時と同じ値がビルドにも渡る | **ビルドには渡らない**。`NEXT_PUBLIC_*` はビルド時の環境変数として別に渡す。`OPERATOR_*` は実行時だけでよい（§9） |
| 処理時間の上限 | ルートの `maxDuration`（300秒） | Cloud Run のリクエストのタイムアウト（`maxDuration` は効かない）。**300秒以上**に設定する |
| アクセスの保護 | Deployment Protection | 公開（Stripe の Webhook のため認証なしの呼び出しを許可）。`SITE_STATUS=development` で一般の利用を止める |
| 定期処理（Cron） | `vercel.json` の Cron は Production だけ | Cloud Scheduler（§7） |
| `/api/health` の `vercel-protection` | 判定できる | 「不明」と表示される（想定どおり） |

---

## 3. Cloud Run Sandbox の構築条件

- Google Cloud のプロジェクトは Firestore（`uranai-b6edf`）とは**別**にする。`uranai-b6edf` に請求先をリンクしない（Blaze になり Firestore の超過が課金される）
- リージョン `asia-northeast1`、リクエストベースの課金、最小インスタンス 0、最大インスタンス 1、タイムアウト 300 秒以上
- ビルドは `npm run build`、起動は `npm start`（`next start` は Cloud Run の `PORT` を読む。ローカルで `PORT=8080` での起動を確認済み、Cloud Run 上は**未検証**）
- Node.js は 22（ビルド時の環境変数 `GOOGLE_NODEJS_VERSION`。`package.json` は変更しない）
- デプロイは、**コミット済みのコードだけ**を新しく clone した場所から行う（追跡していないファイル・`.env*` を送らない）
- 実行時の環境変数（名前だけ）：
  - 接続先：`VERCEL_ENV`（`preview`）、`VERCEL_GIT_COMMIT_REF`（`preview/stripe-sandbox-v2`）、`DB_PROVIDER`、`FIREBASE_PROJECT_ID`（`uranai-stripe-sandbox-v2`）、`PRODUCTION_FIREBASE_PROJECT_ID`（`uranai-b6edf`）、`FIREBASE_CLIENT_EMAIL`、`FIREBASE_PRIVATE_KEY`
  - 公開状態：`APP_URL`、`SITE_STATUS`（`development`）、`TRUSTED_ORIGIN_SOURCE`（`app-url`）
  - 秘密：`SESSION_SECRET`、`DATA_ENCRYPTION_KEY`、`CRON_SECRET`
  - Stripe：§6.2 参照
  - 診断（一時的）：`CLIENT_IP_DIAGNOSTICS`、`CLIENT_IP_DIAGNOSTICS_TOKEN`
- `CLIENT_IP_SOURCE` は、§5 の診断で位置を決めるまで**設定しない**

---

## 4. Firestore の認証

| 環境 | 方式 | 設定 |
| --- | --- | --- |
| Vercel（現在） | 秘密鍵 | 変更しない（`FIREBASE_CREDENTIALS` を設定しない） |
| Cloud Run Sandbox | 秘密鍵 | `FIREBASE_CLIENT_EMAIL`・`FIREBASE_PRIVATE_KEY`（Sandbox のプロジェクトのサービスアカウント）。Preview の接続先の確認がメールアドレスで同じプロジェクトのものかを確かめるため、秘密鍵なしの方式は使えない |
| Cloud Run 本番 | 秘密鍵なし | `FIREBASE_CREDENTIALS=application-default`、`FIREBASE_PROJECT_ID`（`uranai-b6edf`）、`VERCEL_ENV`（`production`）。`FIREBASE_CLIENT_EMAIL`・`FIREBASE_PRIVATE_KEY` は登録しない |

本番の IAM（**未実施**）：`uranai-b6edf` の IAM で、Cloud Run の本番の実行用サービスアカウントに「Cloud Datastore ユーザー」（`roles/datastore.user`）を付与します。

- Compute Engine の既定のサービスアカウントは使わない
- バックアップ用の読み取り専用アカウントは使い回さない

別のプロジェクトのサービスアカウントで接続できることは、Cloud Run 上で**未検証**です。

---

## 5. 送信元 IP の判定の診断（Sandbox だけ）

Cloud Run に run.app で直接アクセスしたときの `X-Forwarded-For` の形は、公式文書に記載がなく**未検証**です。
ロードバランサの公式文書では「末尾の2件（利用者の IP、ロードバランサの IP）だけが信頼でき、それより前は利用者が書いた値」とされていますが、run.app に同じ形が当てはまるかは確かめていません。

### 5.1 診断が有効になる条件（すべて必要。1つでも欠ければ 404）

- `CLIENT_IP_DIAGNOSTICS=on`
- Cloud Run 上（`K_SERVICE` がある）で、Vercel 上ではない（`VERCEL` が無い）
- `VERCEL_ENV=preview`、`FIREBASE_PROJECT_ID` がコードに固定した Preview 用のプロジェクト（本番ではない）、`PRODUCTION_FIREBASE_PROJECT_ID` が本番のプロジェクト ID
- Stripe の Live 用のキー（`sk_live_`・`rk_live_`）も `STRIPE_LIVE_CHECKOUT=on` も無い
- `CLIENT_IP_DIAGNOSTICS_TOKEN` が32文字以上

認証は「診断用のトークン」と「運営アカウントのログイン」の両方です。

トークンの送り方は、次の**どちらか一方だけ**です（値はどちらも `CLIENT_IP_DIAGNOSTICS_TOKEN`）。

- `Authorization: Bearer <トークン>`
- `x-client-ip-diagnostics-token: <トークン>`（専用ヘッダー）

**両方のヘッダーがあるときは、値に関係なく 401** です（どちらを優先するかを作らない）。
Google Cloud 側の認証が `Authorization` を使う経路では、専用ヘッダーを使います。

- 例：Cloud Run を非公開（呼び出し権限）にして ID トークンで呼ぶ場合
- このとき Google 側の ID トークンは `Authorization` ではなく `X-Serverless-Authorization` で送る（Cloud Run の公式の方法）
- Google 側の ID トークンが `Authorization` に残っていると、両方のヘッダーがある扱いで 401 になる

**IAP（Identity-Aware Proxy）の後ろでの動作は未検証**です。IAP がアプリ宛ての `Authorization` やほかのヘッダーをどう扱うか、公式資料で確認できていません。

- トークンが違えば 401、ログインしていなければ 403
- トークンを確かめるまでは Firestore を読まない
- 応答は `Cache-Control: no-store`
- IP・ヘッダーの値・Cookie・トークン・Stripe の値は返さず、保存もログ出力もしない

### 5.2 手順（Sandbox ができてから。実施には承認が必要）

1. 診断用のトークンを自分の端末で作り（32文字以上のランダムな値）、Cloud Run の Sandbox にだけ登録する。**チャット・文書・Git には書かない**
2. Sandbox の URL を開き、運営アカウントでログインする
3. 自分の IP を確かめる。Cloud Logging のリクエストログの `httpRequest.remoteIp` を見る（外部のサービスに頼らない）
4. 同じブラウザで開発者ツールのコンソールを開き、同じオリジンに次を送り、応答の `clientIp` を見る
   - `fetch("/api/ops/client-ip", { headers: { "x-client-ip-diagnostics-token": "<トークン>", "x-diagnostics-expected-ip": "<手順3の IP>" } })`
   - 専用ヘッダーの代わりに `authorization: "Bearer <トークン>"` でもよい（両方は付けない）
   - `<トークン>` はその場で入力し、コンソールの履歴・スクリーンショット・チャットに残さない
   - 非公開（呼び出し権限）のまま curl で呼ぶ場合：
     - Google 側の ID トークンを `X-Serverless-Authorization: Bearer` で付ける
     - アプリのトークンは専用ヘッダーで付ける
     - 運営ログインの Cookie も付ける
     - この経路は**未検証**
5. 偽装の試験：同じ呼び出しに `x-forwarded-for: 192.0.2.1`、`x-real-ip: 198.51.100.1`、`x-forwarded-host: evil.example` を加えて送る
   - 文書用のアドレス（RFC 5737）なので、応答の `documentationAddress: true` で、偽の値が何番目に入ったかが分かる
   - ブラウザがこれらのヘッダーを送るかは**未検証**。送れない場合は curl でトークンとログインの Cookie を付けて送る（Cookie・トークンを共有しない）
6. 別のネットワーク（携帯回線・別の Wi-Fi）でも 4 と 5 を繰り返す。可能なら IPv6 の回線でも試す（**未検証**）

### 5.3 結果から位置を決めるときの注意

- 採用する位置は、次の**すべて**を満たすものだけ：
  - どのネットワークでも `matchesExpected: true`
  - 偽装の試験で `documentationAddress: false`
  - 偽の値の件数を変えても、右から数えた位置が変わらない
- 1つでも満たさない・結果が回によって違う場合は、位置を決めない（`CLIENT_IP_SOURCE` を設定しない）
- その場合、**Cloud Run での一般公開もしない**。従来の判定のままでは `X-Real-IP` を偽装されるおそれがある
- 位置を設定した後、`CLIENT_IP_SOURCE`・`CLIENT_IP_XFF_POSITION_FROM_RIGHT` を Sandbox に入れて、もう一度診断する
  - `clientIpSource.resolution` が `resolved` で、`resolvedMatchesExpected` が `true` になることを確かめる
- **位置を誤ったときの影響（コードでは検出できない）：**
  - 位置が大きすぎて件数が足りない：全員が1つの枠を共用する。例えばログインの上限（15分で10回）にサイト全体で達し、誰もログインできなくなる
  - 利用者が書ける位置を指した：偽装を防げない
- `X-Real-IP`・`X-Forwarded-Host`・`X-Forwarded-Proto` を Google が上書きするかは、同じ応答の `xRealIp`・`xForwardedHost`・`xForwardedProto` で確かめる

---

## 6. X-Forwarded-Host 対策と Stripe Sandbox の接続確認

### 6.1 X-Forwarded-Host 対策

`TRUSTED_ORIGIN_SOURCE=app-url` を設定すると、次の3箇所が `APP_URL` のオリジンだけを基準にします。

- 自サイトからのリクエストかの確認（`isSameOrigin`）
- テストモードの同じ確認（`isSameHostRequest`）
- 占い結果の共有 URL

詳しい動き：
- `Origin` が `APP_URL` と完全に一致するときだけ許可する。`Origin` が無ければ `Referer` を見る
- 両方とも無い・`Origin: null` は拒否する
- `Host`・`X-Forwarded-Host` を偽装しても、許可されず、共有 URL にも入らない（単体テストで確認済み）
- Stripe の Webhook・定期処理は、この確認を使わない（署名・トークンで認証）

Cloud Run 上で、ブラウザが送る `Origin` が `APP_URL` と一致することは**未検証**です（§8 の URL の形に注意）。

### 6.2 Stripe Sandbox の接続確認（実施には承認が必要）

Stripe のテスト決済の条件は Vercel Preview と同じです。

- 環境変数：`PAYMENT_PROVIDER`、`STRIPE_TEST_CHECKOUT`、`STRIPE_SECRET_KEY`（`sk_test_` のみ）、`STRIPE_WEBHOOK_SECRET`、`STRIPE_TEST_FIREBASE_PROJECT_ID`、`STRIPE_ACCOUNT_ID`、`STRIPE_NEW_CHECKOUT`
- 詳細は [sandbox-v2-setup.md](sandbox-v2-setup.md) を参照

手順：
1. Stripe（Sandbox の表示を確認）の Webhook に、Cloud Run の Sandbox 用のエンドポイント `https://<APP_URL のホスト>/api/webhooks/stripe` を追加する
   - イベントの種類は既存のエンドポイントと同じにする（[ARCHITECTURE.md](ARCHITECTURE.md)）
2. 発行された署名の秘密を、Cloud Run の Sandbox の `STRIPE_WEBHOOK_SECRET` にだけ登録する。Vercel の値は変更しない
3. テストカードで決済し、次を確かめる：
   - Webhook が 200 を返す
   - 注文が反映される
   - キャンセル・期限切れの扱い
   - 同じイベントを Stripe から再送しても二重に処理されない
4. Vercel Preview の Sandbox 用のエンドポイントも同じイベントを受け取る。同じ Firestore を見ていれば二重処理は防がれる（リース方式）
5. 決済の戻り先は `APP_URL` を基準にする

Cloud Run 上ではすべて**未検証**です。

---

## 7. 定期処理（Cron）の二重実行の防止

- 定期処理は `GET /api/cron/maintenance`（`Authorization: Bearer` + `CRON_SECRET`）
- 同時に2つは走らない（実行のリース）。ただし、Vercel の Cron と Cloud Scheduler の両方を有効にすると、**1日に2回**実行される
- Sandbox：Vercel の Cron は Production だけで動くので、Sandbox は二重にならない
  - Scheduler のジョブを作る場合も、手動の実行は承認を得てからにする
- 本番の切り替え（承認が必要）：
  1. Cloud Scheduler のジョブを**一時停止の状態で**作る
     - リージョン `asia-northeast1`、頻度 `17 3 * * *`、タイムゾーン `Asia/Tokyo`
     - HTTP GET、ヘッダー `Authorization: Bearer` + `CRON_SECRET`
     - 再試行 0、試行期限は Cloud Run のタイムアウト以上
  2. Vercel の Cron を無効にする
     - Vercel は環境変数を変えても再デプロイまで反映されない
     - プロジェクト設定の Cron Jobs の無効化を使う（画面の項目は**未確認**）
  3. Scheduler のジョブを再開する
  4. 翌日、実行が1回だけであることを運営画面・`/api/health` の `maintenance` で確かめる
- Cron を手動で実行しない（承認なしに）

---

## 8. APP_URL の設定

- Cloud Run では**必須**です。値は `https://` から始まるオリジンだけにする（パスなし）
- **設定漏れの影響：** `http://localhost:3000` として扱われるため、次が起きます
  - Secure Cookie が無効になる
  - QR コードが localhost を指す
  - Stripe の戻り先が壊れる
  - `TRUSTED_ORIGIN_SOURCE=app-url` を設定していれば、API が停止する（気付ける側に倒れる）
- run.app には2つの形の URL がある（プロジェクト番号を含む新しい形と、ハッシュを含む旧い形）
  - `APP_URL` に設定した方だけを案内・QR に使う
  - もう一方の URL からの操作は、オリジンの確認で拒否される
- QR コードは `APP_URL` から作るので、**最終的な URL を決めるまで印刷しない**

---

## 9. 法務・運営者情報のページと、ビルド時に必要な NEXT_PUBLIC_*

### 9.1 実行時に読むもの・ビルド時に固定されるもの

| 対象 | 読み込むとき | 補足 |
| --- | --- | --- |
| `OPERATOR_*`（運営者の情報） | **実行時** | `/commercial-transaction`・`/terms`・`/privacy` はアクセスのたびに作る（`force-dynamic`）。Cloud Run の実行時の環境変数を変えて新しいリビジョンにすれば、再ビルドなしで反映される |
| `NEXT_PUBLIC_*`（サイト名・説明・ロゴ・テーマ色。`src/config/site.ts`） | **ビルド時** | ブラウザ用・サーバー用のコードの両方に埋め込まれる。法務ページ内のサイト名・全ページのタイトルも含む。Cloud Run では**ビルド時の環境変数**として渡す（秘密ではない）。未設定なら既定値（「100円占い」など） |
| 以前の名前 `NEXT_PUBLIC_OPERATOR_*` | 実行時 | 移行のため読み取るだけ。設定しない（`OPERATOR_*` を使う） |
| `/store` | — | ログイン後の画面への転送だけで、環境変数を使わない（静的のまま） |
| `/_not-found` | ビルド時 | 共通のレイアウトのサイト名（`NEXT_PUBLIC_*`）だけ |

- 法務ページの応答は `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` です（Next.js の動的ページの既定）。キャッシュした古い表示は出ません
- 法務ページは Firestore に接続しません
- 秘密の値（`SESSION_SECRET`・Stripe のキーなど）はビルド時に渡しません
- ローカルで確認済み：環境変数なしでビルドし、起動時に渡した値が表示されること、値を変えて起動し直すと表示が変わること、上の `Cache-Control`
- Cloud Run 上では**未検証**

### 9.2 未設定・不正な値のときの表示（従来どおり）

- 屋号・問い合わせ先が未設定なら、既定の値（`src/config/operator.ts` の確定済みの屋号・問い合わせ先）を表示します
- 氏名・所在地・電話番号が未設定なら「請求があれば遅滞なく開示」と表示します（法令上の条件は公開前に要確認）
- 仮の値（example.com・【…】・「設定してください」など）や形式の誤りは**表示に使いません**。架空の運営者情報は公開されません

### 9.3 公開前のチェック（Cloud Run の本番。実施には承認が必要）

1. 運営アカウントで `/api/health` を開く
   - `operatorInfo` が `ok` であること
   - **Cloud Run 上（`K_SERVICE` がある）では、仮の値・不正な値があると `ok=false`（503）** になります。Vercel では従来どおり `ok` の判定に含めません
2. `operatorDisclosure` が意図どおりであること
   - `listed`：氏名・所在地・電話番号を記載
   - `on-request`：請求時開示
   - 未設定は誤りとして検出できないため、この表示で確かめる
3. `/commercial-transaction`・`/terms`・`/privacy` を開き、運営者の情報とサイト名が意図どおりであることを目で確かめる
   - サイト名が既定値のままなら、ビルド時の `NEXT_PUBLIC_*` の渡し忘れ
4. 確認の結果（値そのもの）を、チャット・文書・スクリーンショットで共有しない

## 10. Sandbox 専用の診断の削除手順

位置を決めて §5.3 の再確認が済んだら、すぐに削除します。

1. Cloud Run の Sandbox から `CLIENT_IP_DIAGNOSTICS` と `CLIENT_IP_DIAGNOSTICS_TOKEN` を削除する（新しいリビジョンになる）
2. コードから次の3ファイルを削除する。ほかのファイルからは参照していない
   - `src/lib/ops/client-ip-diagnostics.ts`
   - `src/app/api/ops/client-ip/route.ts`
   - `tests/client-ip-diagnostics.test.ts`
3. この文書の §1 の表・§5.1・§5.2 と、`.env.example` の診断の2行を削除する
4. 単体テスト・型チェック・ビルドを実行し、`GET /api/ops/client-ip` が 404 になることを確かめる
5. 作ったトークンは端末から破棄する（再利用しない）

---

## 11. 未検証の事項（まとめ）

- Cloud Run 上での起動・ビルド（buildpacks がビルド時の環境変数を `next build` に渡すか）
- run.app での `X-Forwarded-For` の形、`X-Real-IP`・`X-Forwarded-Host`・`X-Forwarded-Proto` の扱い、IPv6
- 別のプロジェクトのサービスアカウントによる Firestore の接続（秘密鍵なしの方式）
- Cloud Run 上での Stripe Sandbox の Webhook・決済の戻り先
- Cloud Scheduler からの定期処理、Vercel の Cron の無効化の画面
- ブラウザの開発者ツールから診断に `X-Forwarded-For` などを付けて送れるか
- 法務ページが Cloud Run の実行時の `OPERATOR_*` を表示すること、ビルド時の `NEXT_PUBLIC_*` がサイト名に反映されること
- IAP の後ろでの診断・ログイン、`X-Serverless-Authorization` を使った経路
