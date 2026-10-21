# 本番の環境変数の確認とバックアップの手順書（初心者向け）

この手順書で使うコマンドは2種類です。どちらも**本番のデータを書き換えません**。

| コマンド | 内容 |
|---|---|
| `npm run check:env` | Vercel の本番の環境変数が正しい形式かを確認する（値は表示しません） |
| `npm run backup:firestore` | 本番の Firestore を読み取り専用でバックアップする（暗号化して保存） |
| `npm run backup:verify` | バックアップが壊れていないかを確認する |
| `npm run backup:restore-emulator` | バックアップを、パソコンの中の練習用データベース（Emulator）にだけ戻して確認する |

> **大切なこと**
> - 鍵ファイル（`.json`）、`.env.production.check`、バックアップ（`.ufbk`）は、**GitHub に上げない・人に送らない・チャットに貼らない**でください。
> - バックアップの合言葉と `DATA_ENCRYPTION_KEY` は、パスワード管理アプリなどに**バックアップとは別に**保管してください。
> - 合言葉を忘れると、バックアップは誰にも（作った本人にも）戻せません。

---

## 0. 最初に1回だけ行う準備

1. **Node.js 22** をパソコンに入れます（https://nodejs.org の「LTS」）。Windows では **Git for Windows**（https://git-scm.com）も入れます。
2. このリポジトリを `backup-tools` ブランチで取得し、フォルダの中で次を実行します。
   ```
   git clone https://github.com/fukashigi-app/uranai.git
   cd uranai
   git switch backup-tools
   npm ci
   ```
   - 非公開のリポジトリの場合、初回はブラウザで GitHub のログイン画面が開きます。
3. **Vercel CLI** を入れてログインし、このプロジェクトに紐付けます。
   ```
   npm i -g vercel
   vercel login
   vercel link
   ```
   `vercel link` では、本番で使っているプロジェクトを選んでください。
   - **`vercel` や `vercel deploy`、`vercel --prod` は実行しないでください。** その場でデプロイが始まります。この手順書で使うのは `login`・`link`・`env pull` だけです。

### Windows で使うときの注意

- **「PowerShell」か「Windows Terminal」で実行してください。** 「Git Bash」では、合言葉を入力したときに文字が表示されてしまうことがあります（その場合は警告が出ます）。
- ファイルの場所は `~` ではなく **`$HOME\…`** と書きます（例：`$HOME\uranai-secrets\backup-readonly.json`）。この手順書では Mac と Windows の書き方を併記しています。
- `--key` などの指定が認識されない（「--key <鍵JSON>…を指定してください」と出る）ときは、`npm` を **`npm.cmd`** に変えて実行してください。
- 合言葉は画面での入力を使い、`$env:BACKUP_PASSPHRASE` には入れないでください（PowerShell の履歴に残ります）。パスワード管理アプリからの貼り付け（Ctrl+V または右クリック）は使えます。
- Windows では「自分だけが読めるファイル」の設定がされません。鍵とバックアップは、自分のユーザーフォルダ（`$HOME` の中）に置き、パソコンは自分だけのアカウントで使ってください。

---

## 1. 本番の環境変数の確認（`check:env`）

1. 本番の環境変数を、パソコンに一時的に取り出します。
   ```
   vercel env pull .env.production.check --environment=production
   ```
   - `.env` で始まるファイルは GitHub に上がらない設定になっています。
2. 形式を確認します（ネットワークには接続しません）。
   ```
   npm run check:env
   ```
3. 結果の見方

   | 記号 | 意味 |
   |---|---|
   | ✔ | 正常 |
   | ⚠ | 注意（意図した設定か確認してください） |
   | ✘ | エラー（直す必要があります） |
   | ？ | 確認できない（Vercel で「Sensitive」にした値は取り出せないため空になります。デプロイ後に `/api/health` で確認します） |

   - 例：`✘ FIREBASE_PRIVATE_KEY: 決済サービスのキー（sk_/pk_ で始まる形式）が入っています` と出た場合は、Firebase の秘密鍵を登録し直す必要があります（下の「困ったとき」）。
4. （任意）本番の Firestore に**読み取りだけ**で接続できるかも確認できます。
   ```
   npm run check:env -- --ping
   ```
   コレクションの一覧を取得するだけで、何も書き込みません。
5. **終わったら、取り出したファイルを必ず削除します。**
   - Mac：`rm .env.production.check`
   - Windows：`del .env.production.check`

---

## 2. バックアップ専用の「読み取り専用アカウント」を作る（最初に1回）

本番アプリ用の鍵は書き込みもできるので、バックアップには使いません。**読み取りしかできないアカウント**を別に作ります（Spark プランのまま無料で作れます）。

1. https://console.cloud.google.com を開き、画面上部で Firebase と同じプロジェクトを選びます。
2. 左のメニューの「IAM と管理」→「サービス アカウント」→「＋サービス アカウントを作成」を押します。
   - 名前：`uranai-backup-readonly`（例）
   - 「作成して続行」を押します。
3. 「ロールを選択」で **「Cloud Datastore 閲覧者」**（英語表示なら *Cloud Datastore Viewer*）を選び、「完了」を押します。
   - **これ以外のロールは付けないでください**（書き込みできるロールを付けると意味がなくなります）。
4. 作ったアカウントを開き、「鍵」タブ →「鍵を追加」→「新しい鍵を作成」→「JSON」を選びます。鍵のファイルがダウンロードされます。
5. 鍵のファイルを、**リポジトリの外**の専用フォルダに移します。
   - 例：ホームフォルダに `uranai-secrets` フォルダを作り、`backup-readonly.json` という名前にする
     - Mac：`mkdir ~/uranai-secrets`
     - Windows（PowerShell）：`mkdir $HOME\uranai-secrets`（エクスプローラーでは `C:\Users\<ユーザー名>\uranai-secrets`）
   - リポジトリ（`uranai` フォルダ）の中に置くと、ツールが実行を拒否します（GitHub に上げないための安全装置）。
   - Mac では、自分だけが読めるようにしておきます：`chmod 600 ~/uranai-secrets/backup-readonly.json`
6. 鍵がいらなくなったら、同じ「鍵」タブで削除できます。削除すると、その鍵ではすぐに読めなくなります。

---

## 3. バックアップを取る

1. まず件数と読み取り回数の目安を確認します（データの中身は読みません）。
   - Mac：
     ```
     npm run backup:firestore -- --key ~/uranai-secrets/backup-readonly.json --estimate
     ```
   - Windows（PowerShell）：
     ```
     npm run backup:firestore -- --key $HOME\uranai-secrets\backup-readonly.json --estimate
     ```
   - Spark の無料枠は1日5万回の読み取りです。目安がそれより十分少なければ大丈夫です。
2. バックアップを作ります。保存先は、リポジトリの外の専用フォルダがおすすめです（無ければ作られます）。
   - Mac：
     ```
     npm run backup:firestore -- --key ~/uranai-secrets/backup-readonly.json --out ~/uranai-backups
     ```
   - Windows（PowerShell）：
     ```
     npm run backup:firestore -- --key $HOME\uranai-secrets\backup-readonly.json --out $HOME\uranai-backups
     ```
3. 合言葉（16文字以上）を2回入力し、それぞれ Enter を押します。入力した文字は画面に表示されません。
   - パスワード管理アプリからの貼り付けも使えます。間違えたら Backspace で消せます。
   - 合言葉はパスワード管理アプリに保存してください。
4. 終わると、次の2つのファイルができます。
   - `uranai-backup-YYYYMMDDTHHMMSSZ.ufbk`：暗号化されたバックアップ本体
   - `uranai-backup-…manifest.json`：作成日時・件数・ハッシュなどの説明（中身の値やドキュメントIDは入っていません）

補足
- 画面に表示されるのは、トップレベルのコレクション名と件数だけです。
- バックアップは「開始時点」の内容で全件を読みます。途中で変わったデータが混ざりません（読み取りが1時間以内に終わる必要があります）。

---

## 4. バックアップが壊れていないか確認する

- Mac：
  ```
  npm run backup:verify -- ~/uranai-backups/uranai-backup-XXXX.ufbk
  ```
- Windows（PowerShell）：
  ```
  npm run backup:verify -- $HOME\uranai-backups\uranai-backup-XXXX.ufbk
  ```
- ファイル名の `XXXX` の部分は、`Tab` キーで補完できます。

- 合言葉を入力します。
- 「✔ 復号・件数・内容のハッシュの確認に成功しました」と出れば正常です。
- 失敗した場合（合言葉違い・ファイルの破損・改ざん）は理由が表示されます。

---

## 5. 復元テスト（パソコンの中の練習用データベースにだけ戻す）

本番には絶対に戻しません。ツールは、パソコンの中の Firestore Emulator の `demo-` で始まるプロジェクトにしか書き込めないようになっています。

1. **Java 21** をパソコンに入れておきます（Emulator に必要）。
2. ターミナルを2つ開きます。
3. **1つ目のターミナル**で Emulator を起動し、そのままにしておきます。
   ```
   npx -y firebase-tools@15 emulators:start --only firestore --project demo-uranai
   ```
4. **2つ目のターミナル**で復元テストを実行します（`--project` には `demo-` で始まる新しい名前を付けます）。
   - Mac：
     ```
     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run backup:restore-emulator -- ~/uranai-backups/uranai-backup-XXXX.ufbk --project demo-restore-1021
     ```
   - Windows（PowerShell）：
     ```
     $env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
     npm run backup:restore-emulator -- $HOME\uranai-backups\uranai-backup-XXXX.ufbk --project demo-restore-1021
     ```
5. 「✔ 復元先を読み直して、全ドキュメント（ID・型・値）がバックアップと一致することを確認しました」と出れば成功です。
6. 1つ目のターミナルで `Ctrl + C` を押して Emulator を止めます（練習用のデータは消えます）。

**月1回程度**、この復元テストを行うと安心です。

---

## 6. 保管のルール（おすすめ）

| 項目 | おすすめ |
|---|---|
| いつ取るか | 本番へのデプロイの前、データの整理の前、それ以外は週1回 |
| 保管場所 | パソコンの専用フォルダと外付けドライブの2か所。必要ならクラウドストレージにも（暗号化済みなので可） |
| 残す数 | 毎日の分を7つ、毎週の分を4つ、毎月の分を6つ。古いものから削除 |
| 合言葉 | パスワード管理アプリに保存。バックアップファイルと同じ場所には置かない |
| `DATA_ENCRYPTION_KEY` | 同じくパスワード管理アプリに保存（振込先の情報は、この値が無いと読めません） |

バックアップには、運営・店舗アカウントのメールアドレス、店舗の連絡先、取引の記録などが含まれます。大切に扱ってください。

---

## 困ったとき

| 表示 | 対処 |
|---|---|
| `HTTP 403 PERMISSION_DENIED` | 2で付けたロールが「Cloud Datastore 閲覧者」か、プロジェクトが合っているか確認する |
| `読み取りに時間がかかりすぎたため中断しました` | もう一度実行する |
| 時点の指定（readTime）に関するエラーが続く | `--no-read-time` を付けて実行する（読み取り中の変更が混ざる可能性がある点に注意） |
| `鍵ファイルが Git の管理対象の場所にあります` | 鍵をリポジトリの外のフォルダ（例：`$HOME\uranai-secrets`）に移す |
| `--key <鍵JSON>（本番）または …を指定してください`（Windows） | `npm` を `npm.cmd` に変えて同じコマンドを実行する |
| `この画面では入力した合言葉が表示されることがあります` | Git Bash ではなく PowerShell か Windows Terminal で実行し直す |
| `npm` や `git` が見つからない（Windows） | Node.js・Git for Windows を入れたあと、PowerShell を開き直す |
| `FIRESTORE_EMULATOR_HOST が設定されています` | 本番のバックアップでは、Emulator 用の設定を外す（新しいターミナルを開く） |
| `check:env` で `FIREBASE_PRIVATE_KEY` がエラー | Firebase コンソール →「プロジェクトの設定」→「サービス アカウント」→「新しい秘密鍵を生成」で JSON を作り、その `private_key` を `-----BEGIN` から `-----END PRIVATE KEY-----` まで丸ごと Vercel に登録し直す。古い鍵は削除する。**直すまで本番を再デプロイしない** |

---

## このバックアップで守れるもの・守れないもの

- **守れるもの**
  - Firestore のすべてのコレクション・サブコレクション
  - ドキュメントID
  - データの型（整数と小数・日時・位置・参照・バイナリ・入れ子・null）
- **守れないもの**
  - Vercel の環境変数（別途、パスワード管理アプリに控えてください）
  - Firestore のルールとインデックスの設定（リポジトリの `firestore.rules` にあります）
- **本番への復元**：このツールには含めていません。必要になった場合は、手順を別に用意して、慎重に行います。
