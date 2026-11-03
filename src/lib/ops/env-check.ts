/**
 * 本番の環境変数の「形式」だけを検証する（npm run check:env から使う）。
 *
 * - 値そのもの（秘密鍵・パスワード・URL など）は結果に一切含めない。結果は変数名・判定・説明文だけ。
 * - Vercel から取り出したファイル（vercel env pull）や .env を読み、ネットワークには接続しない。
 * - next.config・テストからも読み込めるよう、server-only やアプリ本体のモジュールには依存しない。
 */
import { createPrivateKey } from "node:crypto";
import { readOperatorInfo } from "../../config/operator";
import { normalizePrivateKey } from "../firestore/private-key";
import { isSessionSecretStrong, livePaymentKeyNames } from "../env-rules";
import { STRIPE_LIVE_DENY_MESSAGE, stripeLiveConfig, STRIPE_TEST_DENY_MESSAGE, stripeTestConfig } from "../payments/stripe-guard";
import { checkFirestoreTarget, FIRESTORE_TARGET_MESSAGE, PREVIEW_FIREBASE_TARGETS, previewFirebaseTargetOf, PRODUCTION_FIREBASE_PROJECT_ID, type PreviewFirebaseTarget } from "../firestore/target-guard";

export type CheckLevel = "ok" | "warn" | "error" | "unknown";
export type CheckResult = { key: string; level: CheckLevel; message: string };
type Env = Record<string, string | undefined>;

/** 決済サービスのキーの形式（sk_live_… など） */
const PAYMENT_KEY = /^(sk|pk|rk)_(live|test)_/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** 決済サービスのキーを置いてよい変数 */
const PAYMENT_KEY_VARS = new Set(["PAYJP_SECRET_KEY", "PAYJP_PUBLIC_KEY", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_RESTRICTED_KEY"]);

const has = (v: string | undefined) => typeof v === "string" && v.trim() !== "";

/** Firebase の秘密鍵の形式。値は返さない */
export function checkFirebasePrivateKey(raw: string | undefined): CheckResult {
  const key = "FIREBASE_PRIVATE_KEY";
  if (raw === undefined) return { key, level: "error", message: "未登録です。Firebase に接続できません。" };
  if (raw.trim() === "") {
    return { key, level: "unknown", message: "値が空です（Vercel で「Sensitive」にした変数は取り出せないため空になります）。デプロイ後に /api/health の FIREBASE_PRIVATE_KEY と database を確認してください。" };
  }
  const k = normalizePrivateKey(raw);
  if (PAYMENT_KEY.test(k)) return { key, level: "error", message: "決済サービスのキー（sk_/pk_ で始まる形式）が入っています。Firebase の秘密鍵ではありません。" };
  if (!PEM.test(k) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(k)) {
    return { key, level: "error", message: "-----BEGIN PRIVATE KEY----- から -----END PRIVATE KEY----- までが揃っていません。サービスアカウントJSONの private_key を丸ごと登録してください。" };
  }
  let type: string | undefined;
  try {
    type = createPrivateKey(k).asymmetricKeyType;
  } catch {
    return { key, level: "error", message: "秘密鍵として読み込めません（途中が欠けている・改行の表記が壊れている可能性）。" };
  }
  if (type !== "rsa") return { key, level: "warn", message: "読み込めますが、Firebase のサービスアカウント鍵（RSA）ではない可能性があります。" };
  if (/BEGIN RSA PRIVATE KEY/.test(k)) return { key, level: "warn", message: "古い形式（PKCS#1）です。サービスアカウントJSONの private_key（BEGIN PRIVATE KEY）を使ってください。" };
  return { key, level: "ok", message: "秘密鍵として正しく読み込めます。" };
}

/**
 * 本番（Production）用の環境変数を検証する。
 * @param env 取り出した環境変数（vercel env pull の内容など）
 */
export function checkProductionEnv(env: Env): CheckResult[] {
  const r: CheckResult[] = [];
  const add = (key: string, level: CheckLevel, message: string) => r.push({ key, level, message });

  // ---- Firebase ----
  const projectId = env.FIREBASE_PROJECT_ID?.trim() ?? "";
  if (!has(env.FIREBASE_PROJECT_ID)) add("FIREBASE_PROJECT_ID", "error", "未登録です。");
  else if (projectId.startsWith("demo-")) add("FIREBASE_PROJECT_ID", "error", "demo- で始まるのはテスト用（Emulator）のプロジェクトIDです。");
  else if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) add("FIREBASE_PROJECT_ID", "error", "Firebase のプロジェクトIDの形式ではありません（小文字・数字・ハイフン）。");
  else add("FIREBASE_PROJECT_ID", "ok", "形式は正しいです。");

  const email = env.FIREBASE_CLIENT_EMAIL?.trim() ?? "";
  const m = /^[^@\s]+@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/.exec(email);
  if (!has(env.FIREBASE_CLIENT_EMAIL)) add("FIREBASE_CLIENT_EMAIL", "error", "未登録です。");
  else if (!m) add("FIREBASE_CLIENT_EMAIL", "error", "サービスアカウントのメールアドレス（…@<プロジェクト>.iam.gserviceaccount.com）の形式ではありません。");
  else if (projectId && m[1] !== projectId) add("FIREBASE_CLIENT_EMAIL", "warn", "FIREBASE_PROJECT_ID と別のプロジェクトのサービスアカウントです。意図したものか確認してください。");
  else add("FIREBASE_CLIENT_EMAIL", "ok", "形式は正しく、プロジェクトIDとも一致しています。");

  r.push(checkFirebasePrivateKey(env.FIREBASE_PRIVATE_KEY));

  if (has(env.FIRESTORE_EMULATOR_HOST)) add("FIRESTORE_EMULATOR_HOST", "error", "本番に設定してはいけません（本番の Firestore ではなく Emulator に接続しようとします）。");
  if (env.DB_PROVIDER === "firestore") add("DB_PROVIDER", "ok", "firestore です。");
  else if (!has(env.DB_PROVIDER)) add("DB_PROVIDER", has(env.FIREBASE_PROJECT_ID) ? "ok" : "error", has(env.FIREBASE_PROJECT_ID) ? "未設定（FIREBASE_PROJECT_ID があるので Firestore を使います）。" : "未設定で Firebase の設定もありません。");
  else add("DB_PROVIDER", "warn", "firestore 以外が設定されています。本番は Firestore だけを使う方針です。");
  if (has(env.DATABASE_URL)) add("DATABASE_URL", "warn", "PostgreSQL を使わないなら削除してください（残っているとビルド時に接続を試みます）。");
  const prodFs = env.PRODUCTION_FIREBASE_PROJECT_ID?.trim();
  if (prodFs && projectId && prodFs !== projectId) add("PRODUCTION_FIREBASE_PROJECT_ID", "error", "FIREBASE_PROJECT_ID と一致しません。本番が本番以外のプロジェクトに接続する設定になっています。");

  // ---- アプリの秘密の値 ----
  const secret = env.SESSION_SECRET ?? "";
  if (!has(secret)) add("SESSION_SECRET", "error", "未登録です（ログインできません）。");
  else if (secret.length < 32) add("SESSION_SECRET", "error", "32文字以上が必要です。");
  else add("SESSION_SECRET", "ok", "32文字以上です。");

  const dek = env.DATA_ENCRYPTION_KEY ?? "";
  if (!has(dek)) add("DATA_ENCRYPTION_KEY", "error", "未登録です（振込先を保存・表示できません）。");
  else if (Buffer.from(dek.trim(), "base64").length !== 32) add("DATA_ENCRYPTION_KEY", "error", "32バイトを base64 にした値ではありません（openssl rand -base64 32 で作成）。");
  else add("DATA_ENCRYPTION_KEY", "ok", "32バイトの base64 です。");

  const cron = env.CRON_SECRET ?? "";
  if (!has(cron)) add("CRON_SECRET", "error", "未登録です（定期処理が実行されず、占い結果の30日削除などが止まります）。");
  else if (cron.length < 32) add("CRON_SECRET", "warn", "32文字以上を推奨します。");
  else add("CRON_SECRET", "ok", "32文字以上です。");

  if (has(env.APP_URL)) {
    let ok = false;
    try {
      ok = new URL(env.APP_URL!.trim()).protocol === "https:";
    } catch {
      ok = false;
    }
    add("APP_URL", ok ? "ok" : "error", ok ? "https の URL です。" : "https:// で始まる正しい URL ではありません。");
  }

  // ---- 公開状態・決済 ----
  const site = (env.SITE_STATUS ?? "").trim().toLowerCase();
  if (site === "" || site === "open") add("SITE_STATUS", "ok", "未設定または open（一般公開の状態）です。");
  else if (site === "coming_soon") add("SITE_STATUS", "ok", "coming_soon（準備中）です。");
  else if (site === "development") {
    const live = livePaymentKeyNames(env);
    const operatorLive = (env.STRIPE_LIVE_OPERATOR_TEST ?? "").trim().toLowerCase() === "on";
    if (live.length && operatorLive) add("SITE_STATUS", "warn", `development（開発モード）で、運営アカウントだけの本番決済テスト（STRIPE_LIVE_OPERATOR_TEST=on）です。本番用の決済キー（${live.join("・")}）で実際に請求されます。一般の方の決済は受け付けません。確認の後は返金し、公開の前に STRIPE_LIVE_OPERATOR_TEST を削除してください。`);
    else if (live.length) add("SITE_STATUS", "error", `development（開発モード）なのに本番用の決済キー（${live.join("・")}）が登録されています。アプリは占いの受付を全部停止します。開発モード中は本番用の決済キーを削除してください。`);
    else add("SITE_STATUS", "ok", "development（開発モード）です。一般の方には準備中を表示し、決済は受け付けません。無料の占いは運営アカウントだけ（テスト店舗 /s/test と、稼働中の登録店舗の QR）で使えます。");
    if (!isSessionSecretStrong(env)) add("SESSION_SECRET", "warn", "開発モードの無料占いには、安全な SESSION_SECRET（32文字以上・推測しにくい値）が必要です。今の値では無料の占いを提供しません。");
  } else add("SITE_STATUS", "error", "open・coming_soon・development 以外の値です（準備中として扱われます）。");

  if (env.ENABLE_TEST_PAYMENT === "true") {
    add("ENABLE_TEST_PAYMENT", "warn", "true です。今本番で動いているコード（a67ef2c）では誰でも無料テストが使えます。新しいコードでは本番は全部停止します（開発モードの無料占いも使えません）。本番の無料確認には SITE_STATUS=development を使い、ENABLE_TEST_PAYMENT は削除してください。");
  } else if (has(env.ENABLE_TEST_PAYMENT) && env.ENABLE_TEST_PAYMENT !== "false") {
    add("ENABLE_TEST_PAYMENT", "warn", "true / false 以外の値です（無効として扱われます）。");
  }
  if (env.PAYMENT_PROVIDER === "mock") add("PAYMENT_PROVIDER", "error", "mock（疑似決済）は本番では使えません。");
  else if (env.PAYMENT_PROVIDER === "stripe") add("PAYMENT_PROVIDER", has(env.STRIPE_LIVE_CHECKOUT) ? "ok" : "warn", has(env.STRIPE_LIVE_CHECKOUT) ? "stripe です（本番決済の条件は下の STRIPE_LIVE_CHECKOUT の確認を見てください）。" : "stripe です。STRIPE_LIVE_CHECKOUT=on などの本番決済の設定が無いため、本番では決済を受け付けません。");
  else if (env.PAYMENT_PROVIDER === "payjp") add("PAYMENT_PROVIDER", "warn", "payjp は廃止しました（PAY.JP は使っていません。決済は受け付けません）。削除するか、stripe にしてください。");
  else if (has(env.PAYMENT_PROVIDER)) add("PAYMENT_PROVIDER", "error", "対応していない値です（アプリが起動時にエラーになります）。");
  if (env.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION === "true") add("ALLOW_MOCK_PAYMENTS_IN_PRODUCTION", "error", "本番では削除してください。");
  for (const k of ["PAYJP_PUBLIC_KEY", "PAYJP_SECRET_KEY", "PAYJP_WEBHOOK_TOKEN"]) {
    if (!has(env[k])) continue;
    add(k, "warn", "PAY.JP は廃止しました（この設定は読まれず、PAY.JP には接続しません）。削除してください。");
  }

  // ---- Stripe（テスト決済は Preview だけ。本番では使わない） ----
  if (has(env.STRIPE_TEST_CHECKOUT)) add("STRIPE_TEST_CHECKOUT", "error", "Stripe のテスト決済の設定が本番にあります（本番では常に無効）。Preview だけに設定し、本番からは削除してください。");
  if (has(env.STRIPE_API_BASE)) add("STRIPE_API_BASE", "error", "ローカルの自動テスト用の設定です。本番から削除してください。");
  if (has(env.STRIPE_TEST_FIREBASE_PROJECT_ID)) add("STRIPE_TEST_FIREBASE_PROJECT_ID", "warn", "Preview のテスト決済用の設定が本番にあります（本番では使いません）。Preview だけに設定してください。");
  if (!has(env.STRIPE_LIVE_CHECKOUT) && !has(env.STRIPE_LIVE_OPERATOR_TEST)) {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
      if (has(env[k])) add(k, "warn", "Stripe の設定が本番にありますが、本番決済のスイッチ（STRIPE_LIVE_CHECKOUT=on）がありません（使われません）。テスト用の値なら Preview だけに設定してください。");
    }
  }
  // 本番決済のスイッチがあれば、本番の条件（sk_live_・Firebase の接続先など）がそろっているか確かめる（値は出さない）
  if (has(env.STRIPE_LIVE_CHECKOUT) || has(env.STRIPE_LIVE_OPERATOR_TEST)) {
    const live = stripeLiveConfig({ ...env, VERCEL_ENV: "production" });
    if (live.ok)
      add(
        "STRIPE_LIVE_CHECKOUT",
        live.audience === "operator" ? "warn" : "ok",
        live.audience === "operator"
          ? "Stripe の本番決済の設定がそろっています（運営アカウントだけの本番決済テスト。実際に請求されます）。キーが STRIPE_ACCOUNT_ID のアカウントのものかは、アプリが Stripe API で確かめます。"
          : "Stripe の本番決済の設定がそろっています（一般のお客さんの決済）。キーが STRIPE_ACCOUNT_ID のアカウントのものかは、アプリが Stripe API で確かめます。",
      );
    else add("STRIPE_LIVE_CHECKOUT", "error", `Stripe の本番決済の設定に問題があります：${STRIPE_LIVE_DENY_MESSAGE[live.reason]}`);
  }

  // ---- 本番の接続先が Preview 用のプロジェクトになっていないか ----
  if (previewFirebaseTargetOf(env.FIREBASE_PROJECT_ID)) add("FIREBASE_PROJECT_ID", "error", "本番の FIREBASE_PROJECT_ID が Preview（検証環境）用の Firebase プロジェクトになっています。本番のプロジェクトにしてください。");

  // ---- Preview 専用の診断（本番では常に無効。値が残っていれば削除を促す） ----
  if (has(env.OPS_DIAGNOSTICS_TOKEN)) add("OPS_DIAGNOSTICS_TOKEN", "warn", "Preview 専用の診断トークンが本番にあります（本番では使われません）。Preview だけに設定し、本番からは削除してください。");

  // ---- 取り違え・公開してはいけない値 ----
  for (const [k, v] of Object.entries(env)) {
    if (!has(v)) continue;
    const val = v!.trim();
    // FIREBASE_PRIVATE_KEY は checkFirebasePrivateKey で同じ内容を判定済み
    if (PAYMENT_KEY.test(val) && !PAYMENT_KEY_VARS.has(k) && k !== "FIREBASE_PRIVATE_KEY") add(k, "error", "決済サービスのキー（sk_/pk_ で始まる形式）が、別の名前の変数に入っています。取り違えていないか確認してください。");
    if (PEM.test(normalizePrivateKey(val)) && k !== "FIREBASE_PRIVATE_KEY") add(k, "error", "秘密鍵（PEM）が FIREBASE_PRIVATE_KEY 以外の変数に入っています。");
    if (k.startsWith("NEXT_PUBLIC_") && ((PAYMENT_KEY.test(val) && !val.startsWith("pk_")) || PEM.test(val))) {
      add(k, "error", "NEXT_PUBLIC_ の変数はブラウザに公開されます。秘密の値を入れないでください。");
    }
  }

  // ---- 運用 ----
  if (has(env.ADMIN_SETUP_TOKEN)) add("ADMIN_SETUP_TOKEN", "warn", "運営アカウントの作成後は削除して構いません。");
  for (const issue of readOperatorInfo(env).issues) {
    if (issue.key === "disclosure") continue; // 方針どおりの表示（請求時開示）
    add(issue.key, issue.level === "error" ? "error" : "warn", issue.message);
  }
  return r;
}

export function summarize(results: CheckResult[]): Record<CheckLevel, number> {
  const s: Record<CheckLevel, number> = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const x of results) s[x.level] += 1;
  return s;
}

/**
 * Preview（検証環境）の環境変数の「形式」を確かめる（npm run check:env -- --preview から使う。値は結果に含めない・ネットワークに接続しない）。
 * アプリの判定（target-guard.ts の Firestore の接続先・stripe-guard.ts の Stripe のテスト決済）を、VERCEL_ENV=preview として呼ぶ。
 * 新しい検証環境（requireStripeAccountId のプロジェクト）では STRIPE_ACCOUNT_ID が必須。キーが本当にそのアカウントのものかは、
 * デプロイの後にアプリが Stripe API で確かめる（ここでは確かめられない）。
 */
export function checkPreviewEnv(env: Env, targets: readonly PreviewFirebaseTarget[] = PREVIEW_FIREBASE_TARGETS): CheckResult[] {
  const r: CheckResult[] = [];
  const add = (key: string, level: CheckLevel, message: string) => r.push({ key, level, message });
  const target = previewFirebaseTargetOf(env.FIREBASE_PROJECT_ID, targets);
  // ブランチの名前（VERCEL_GIT_COMMIT_REF）は実行時に Vercel が渡す値。取り出したファイルに無ければ、プロジェクトに固定したブランチとして確かめる
  const ref = env.VERCEL_GIT_COMMIT_REF;
  const e = { ...env, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: ref ?? target?.allowedBranches[0] };
  if (env.FIREBASE_PROJECT_ID === PRODUCTION_FIREBASE_PROJECT_ID) add("FIREBASE_PROJECT_ID", "error", "本番の Firebase プロジェクトです。Preview では使えません。");
  else if (!target) add("FIREBASE_PROJECT_ID", "error", "コードで許可した Preview 用の Firebase プロジェクトではありません（src/lib/firestore/target-guard.ts の PREVIEW_FIREBASE_TARGETS）。");
  else add("FIREBASE_PROJECT_ID", "ok", target.requireStripeAccountId ? "許可した検証環境のプロジェクトです（STRIPE_ACCOUNT_ID が必須）。" : "以前からの Preview のプロジェクトです。");
  if (target) {
    if (ref === undefined) add("VERCEL_GIT_COMMIT_REF", "unknown", `ファイルにありません。実行時に Vercel が渡すブランチの名前が、このプロジェクトに固定したブランチ（${target.allowedBranches.join("・")}）と一致しないと接続を止めます（Vercel の System Environment Variables を有効にしてください）。`);
    else if (target.allowedBranches.includes(ref)) add("VERCEL_GIT_COMMIT_REF", "ok", "このプロジェクトに固定したブランチです。");
    else add("VERCEL_GIT_COMMIT_REF", "error", `このプロジェクトに接続できるブランチは ${target.allowedBranches.join("・")} だけです（環境変数の登録先のブランチを確かめてください）。`);
  }
  const fs = checkFirestoreTarget(e, targets);
  add("FIRESTORE_TARGET", fs.ok ? "ok" : "error", fs.ok ? "Firestore の接続先の安全確認を満たしています。" : FIRESTORE_TARGET_MESSAGE[fs.reason]);
  const pk = checkFirebasePrivateKey(env.FIREBASE_PRIVATE_KEY);
  add(pk.key, pk.level, pk.message);
  const st = stripeTestConfig(e, targets);
  if (st.ok) add("STRIPE_TEST_CHECKOUT", "ok", st.accountId ? "Stripe のテスト決済の条件を満たしています（キーのアカウントは、デプロイの後にアプリが Stripe API で確かめます）。" : "Stripe のテスト決済の条件を満たしています（STRIPE_ACCOUNT_ID なし：キーのアカウントは確かめません）。");
  else add("STRIPE_TEST_CHECKOUT", has(env.STRIPE_TEST_CHECKOUT) ? "error" : "warn", `Stripe のテスト決済を使えません：${STRIPE_TEST_DENY_MESSAGE[st.reason]}`);
  if (!isSessionSecretStrong(env)) add("SESSION_SECRET", "error", "32文字以上の推測しにくい値が必要です。検証環境ごとに別の値にしてください。");
  if (!has(env.CRON_SECRET)) add("CRON_SECRET", "warn", "未設定です（定期処理を手で呼んで確かめるときに必要。検証環境ごとに別の値にしてください）。");
  for (const k of ["STRIPE_LIVE_CHECKOUT", "STRIPE_LIVE_OPERATOR_TEST"]) if (has(env[k])) add(k, "error", "本番決済のスイッチが Preview にあります。削除してください。");
  return r;
}
