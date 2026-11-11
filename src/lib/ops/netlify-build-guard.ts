/**
 * Netlify のビルドでの、本番と Sandbox の環境変数の取り違えの検出（ビルドの段階で止める。next.config.ts から本番ビルドのときだけ呼ぶ）。
 *
 * どの環境を Netlify のビルドとみなすか（CONTEXT だけを Netlify の証拠として信用しない）：
 *  - NETLIFY=true … Netlify のビルド（Netlify が必ず設定する読み取り専用の変数）。CONTEXT が無い・想定外でも判定を省略しない
 *  - NETLIFY が無く、CONTEXT がある … Vercel のビルド（VERCEL あり）なら従来どおり何もしない。それ以外は、Netlify を名乗る
 *    出どころの不明な環境として停止する（Netlify の判定をすり抜けない）
 *  - NETLIFY も CONTEXT も無い … Vercel・Cloud Run・ローカル。従来どおり何もしない
 *  - NETLIFY=true と VERCEL が両方ある … 停止（Vercel の目印で Netlify の判定をすり抜けない）
 *
 * Netlify のビルドで許可するのは、次の2つだけ（それ以外の CONTEXT・ブランチは停止）：
 *  - 本番    … CONTEXT=production・BRANCH=netlify/production・VERCEL_ENV=production・
 *              FIREBASE_PROJECT_ID と PRODUCTION_FIREBASE_PROJECT_ID が本番のプロジェクト
 *              Stripe：テスト用のキーは停止。Live のキーがまだ無いときは SITE_STATUS=development に限り許可（STRIPE_LIVE_CHECKOUT=on は停止）
 *  - Sandbox … CONTEXT=branch-deploy・BRANCH=netlify/sandbox・VERCEL_ENV=preview・
 *              FIREBASE_PROJECT_ID が Sandbox v2 のプロジェクト・PRODUCTION_FIREBASE_PROJECT_ID が本番のプロジェクト
 *              Stripe：Live のキー・STRIPE_LIVE_CHECKOUT=on は停止
 * 値の比較は完全一致（前後の空白・大文字の違いも誤りとして扱う）。
 *
 * 副作用なし（環境変数を受け取って結果を返すだけ）。結果・メッセージには変数の名前だけを含め、値（秘密・ブランチ名・プロジェクトID）は含めない。
 * next.config.ts から読み込むため、ほかのモジュールは依存の無い target-guard.ts だけを使う。
 * 実行時の Stripe・Firestore の判定（stripe-guard.ts・target-guard.ts）は変えない。これはその手前の追加の確認。
 */
// next.config.ts から読み込むので、パスの別名（@/）は使わない
import { PRODUCTION_FIREBASE_PROJECT_ID, PREVIEW_FIREBASE_TARGETS, SANDBOX_V2_FIREBASE_PROJECT_ID } from "../firestore/target-guard";

type Env = Record<string, string | undefined>;

export const NETLIFY_PRODUCTION_BRANCH = "netlify/production" as const;
export const NETLIFY_SANDBOX_BRANCH = "netlify/sandbox" as const;

export type NetlifyBuildIssue =
  | "context_without_netlify"
  | "vercel_marker_on_netlify"
  | "context_missing"
  | "context_not_allowed"
  | "branch_not_allowed"
  | "context_branch_mismatch"
  | "vercel_env_missing"
  | "vercel_env_unexpected"
  | "firebase_project_not_production"
  | "firebase_project_is_sandbox"
  | "firebase_project_not_sandbox"
  | "firebase_project_is_production"
  | "production_project_id_unexpected"
  | "stripe_test_key_in_production"
  | "stripe_key_format_unknown"
  | "stripe_live_key_missing_outside_development"
  | "stripe_live_checkout_without_live_key"
  | "stripe_live_key_in_sandbox"
  | "stripe_live_checkout_in_sandbox";

export type NetlifyBuildGuardResult =
  | { kind: "not_netlify" }
  | { kind: "ok"; target: "production" | "sandbox" }
  | { kind: "blocked"; target: "production" | "sandbox" | "unknown"; issues: NetlifyBuildIssue[] };

/** 問題ごとの説明（変数の名前だけ。値は含めない） */
export const NETLIFY_BUILD_ISSUE_MESSAGE: Record<NetlifyBuildIssue, string> = {
  context_without_netlify: "CONTEXT が設定されていますが、Netlify のビルド（NETLIFY=true）ではありません。出どころの不明な環境なので停止します。",
  vercel_marker_on_netlify: "Netlify のビルドに VERCEL が設定されています。",
  context_missing: "Netlify のビルドですが CONTEXT がありません。",
  context_not_allowed: "Netlify の CONTEXT が想定外です（本番の production と、Sandbox の branch-deploy 以外。Deploy Preview も不可）。",
  branch_not_allowed: "Netlify の BRANCH が想定外です（netlify/production と netlify/sandbox 以外）。",
  context_branch_mismatch: "Netlify の CONTEXT と BRANCH の組み合わせが一致しません。",
  vercel_env_missing: "VERCEL_ENV が設定されていません。",
  vercel_env_unexpected: "VERCEL_ENV がこの環境で想定する値ではありません（本番は production、Sandbox は preview）。",
  firebase_project_not_production: "本番なのに FIREBASE_PROJECT_ID が本番のプロジェクトではありません。",
  firebase_project_is_sandbox: "本番に Sandbox 用の Firebase プロジェクト（FIREBASE_PROJECT_ID）が設定されています。",
  firebase_project_not_sandbox: "Sandbox なのに FIREBASE_PROJECT_ID が Sandbox 用のプロジェクトではありません。",
  firebase_project_is_production: "Sandbox に本番の Firebase プロジェクト（FIREBASE_PROJECT_ID）が設定されています。",
  production_project_id_unexpected: "PRODUCTION_FIREBASE_PROJECT_ID が本番のプロジェクトではありません。",
  stripe_test_key_in_production: "本番に Stripe のテスト用のキー（STRIPE_SECRET_KEY）が設定されています。",
  stripe_key_format_unknown: "STRIPE_SECRET_KEY の形式が想定外です。",
  stripe_live_key_missing_outside_development: "本番に Stripe の Live のキー（STRIPE_SECRET_KEY）が無いのは、SITE_STATUS=development のときだけ許可します。",
  stripe_live_checkout_without_live_key: "Stripe の Live のキーが無いのに STRIPE_LIVE_CHECKOUT=on です。",
  stripe_live_key_in_sandbox: "Sandbox に Stripe の Live のキー（STRIPE_SECRET_KEY）が設定されています。",
  stripe_live_checkout_in_sandbox: "Sandbox で STRIPE_LIVE_CHECKOUT=on です。",
};

const LIVE_KEY_RE = /^(sk|rk)_live_/;
const TEST_KEY_RE = /^(sk|rk)_test_/;
const has = (v: string | undefined) => typeof v === "string" && v !== "";
const isOn = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
const isPreviewProject = (v: string | undefined) => PREVIEW_FIREBASE_TARGETS.some((t) => t.projectId === (v ?? "").trim().toLowerCase());

export function checkNetlifyBuildEnv(e: Env = process.env): NetlifyBuildGuardResult {
  const netlify = e.NETLIFY === "true";
  if (!netlify) {
    if (!has(e.CONTEXT) || has(e.VERCEL)) return { kind: "not_netlify" };
    return { kind: "blocked", target: "unknown", issues: ["context_without_netlify"] };
  }
  const issues: NetlifyBuildIssue[] = [];
  if (has(e.VERCEL)) issues.push("vercel_marker_on_netlify");

  const context = e.CONTEXT;
  const branch = e.BRANCH;
  let target: "production" | "sandbox" | "unknown" = "unknown";
  if (!has(context)) issues.push("context_missing");
  else if (context === "production") target = "production";
  else if (context === "branch-deploy") target = "sandbox";
  else issues.push("context_not_allowed");

  if (branch !== NETLIFY_PRODUCTION_BRANCH && branch !== NETLIFY_SANDBOX_BRANCH) issues.push("branch_not_allowed");
  else if ((target === "production" && branch !== NETLIFY_PRODUCTION_BRANCH) || (target === "sandbox" && branch !== NETLIFY_SANDBOX_BRANCH)) {
    issues.push("context_branch_mismatch");
  }

  if (!has(e.VERCEL_ENV)) issues.push("vercel_env_missing");
  else if (target === "unknown" || e.VERCEL_ENV !== (target === "production" ? "production" : "preview")) issues.push("vercel_env_unexpected");

  if (e.PRODUCTION_FIREBASE_PROJECT_ID !== PRODUCTION_FIREBASE_PROJECT_ID) issues.push("production_project_id_unexpected");

  const key = (e.STRIPE_SECRET_KEY ?? "").trim();
  if (target === "production") {
    if (isPreviewProject(e.FIREBASE_PROJECT_ID)) issues.push("firebase_project_is_sandbox");
    else if (e.FIREBASE_PROJECT_ID !== PRODUCTION_FIREBASE_PROJECT_ID) issues.push("firebase_project_not_production");
    if (TEST_KEY_RE.test(key)) issues.push("stripe_test_key_in_production");
    else if (key && !LIVE_KEY_RE.test(key)) issues.push("stripe_key_format_unknown");
    else if (!key) {
      // 公開前（Live のキーをまだ登録していない段階）は、開発モードのときだけビルドを許可する
      if (e.SITE_STATUS !== "development") issues.push("stripe_live_key_missing_outside_development");
      if (isOn(e.STRIPE_LIVE_CHECKOUT)) issues.push("stripe_live_checkout_without_live_key");
    }
  } else if (target === "sandbox") {
    if ((e.FIREBASE_PROJECT_ID ?? "").trim().toLowerCase() === PRODUCTION_FIREBASE_PROJECT_ID) issues.push("firebase_project_is_production");
    else if (e.FIREBASE_PROJECT_ID !== SANDBOX_V2_FIREBASE_PROJECT_ID) issues.push("firebase_project_not_sandbox");
    if (LIVE_KEY_RE.test(key)) issues.push("stripe_live_key_in_sandbox");
    else if (key && !TEST_KEY_RE.test(key)) issues.push("stripe_key_format_unknown");
    if (isOn(e.STRIPE_LIVE_CHECKOUT)) issues.push("stripe_live_checkout_in_sandbox");
  }

  if (issues.length) return { kind: "blocked", target, issues };
  return { kind: "ok", target: target as "production" | "sandbox" };
}

/** 停止するときのエラーメッセージ（変数の名前と問題の識別子だけ。値は含めない） */
export function netlifyBuildGuardMessage(r: Extract<NetlifyBuildGuardResult, { kind: "blocked" }>): string {
  return [
    `[netlify-build-guard] Netlify のビルドの環境変数に誤りがあるため、ビルドを停止しました（対象：${r.target}）。値は表示しません。`,
    ...r.issues.map((i) => `  - ${i}: ${NETLIFY_BUILD_ISSUE_MESSAGE[i]}`),
  ].join("\n");
}

/** next.config.ts から本番ビルドのときに呼ぶ。誤りがあれば例外でビルドを止める（Netlify 以外では何もしない） */
export function assertNetlifyBuildEnv(e: Env = process.env): NetlifyBuildGuardResult {
  const r = checkNetlifyBuildEnv(e);
  if (r.kind === "blocked") throw new Error(netlifyBuildGuardMessage(r));
  return r;
}
