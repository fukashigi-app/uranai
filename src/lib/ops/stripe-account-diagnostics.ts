/**
 * Sandbox v2 専用：Stripe のアカウントの照合の診断（運営画面の「設定」→ POST /api/admin/stripe-account-diagnostics）。
 *
 * 決済画面の作成で StripeAccountMismatchError（キーの持ち主 ≠ STRIPE_ACCOUNT_ID）が出たときに、原因を安全に切り分けるためのもの。
 *  - Stripe には GET /v1/account（キーの持ち主のアカウントの取得）だけを送る。決済画面・PaymentIntent の作成、返金、Webhook の再送はしない
 *  - Firestore には接続しない（読み書きしない）。レート制限も Firestore を使わず、実行中のサーバーのメモリだけで数える
 *  - 結果は真偽値・固定の分類だけ。キー・Webhook の秘密・アカウントの ID の値（一部を含む）・Stripe のエラーの文言は返さない。
 *    不一致のときだけ、アカウントの ID の末尾4文字（返ってきた ID と設定の ID）を返す（どの Sandbox のキーかの見分け用）
 *  - 使えるのは Sandbox v2 の Preview（VERCEL_ENV=preview・Firebase の接続先が uranai-stripe-sandbox-v2・
 *    そのプロジェクトに固定したブランチ preview/stripe-sandbox-v2）だけ。判定はデータベースの接続の判定（target-guard.ts）と、
 *    テスト決済の判定（stripe-guard.ts の stripeTestConfig）をそのまま使う
 * route や単体テストから読み込めるよう、server-only・env.ts・Firestore・Stripe SDK に依存しない（Stripe への問い合わせは引数で受け取る）。
 */
import { checkFirestoreTarget, previewFirebaseTargetOf, SANDBOX_V2_FIREBASE_PROJECT_ID } from "@/lib/firestore/target-guard";
import { stripeTestConfig, type StripeTestDenyReason } from "@/lib/payments/stripe-guard";

type Env = Record<string, string | undefined>;

/** Sandbox v2 の Preview か（Vercel の Preview・Firebase の接続先の判定がすべて ok・接続先が uranai-stripe-sandbox-v2） */
export function isSandboxV2Environment(e: Env = process.env): boolean {
  if (e.VERCEL_ENV !== "preview") return false;
  // Preview の接続先の判定（本番の拒否・サービスアカウント・プロジェクトとブランチの組み合わせ）。ブランチは target-guard.ts に固定した preview/stripe-sandbox-v2 だけ
  if (!checkFirestoreTarget(e).ok) return false;
  return previewFirebaseTargetOf(e.FIREBASE_PROJECT_ID)?.projectId === SANDBOX_V2_FIREBASE_PROJECT_ID;
}

/** 画面に出してよいエラーの分類（固定の値だけ。Stripe のエラーの文言・リクエストの ID は含めない） */
export type StripeAccountDiagnosticsError =
  | `config_${StripeTestDenyReason}`
  | "runtime_unavailable"
  | "stripe_authentication"
  | "stripe_permission"
  | "stripe_rate_limit"
  | "stripe_connection"
  | "stripe_api"
  | "stripe_invalid_request"
  | "invalid_response"
  | "unknown";

export type StripeAccountDiagnosticsResult = {
  /** 実行環境（この結果は Sandbox v2 でしか作らない） */
  environment: "sandbox_v2";
  secretKeySet: boolean;
  /** STRIPE_SECRET_KEY がテスト用（sk_test_） */
  secretKeyIsTest: boolean;
  accountIdSet: boolean;
  webhookSecretSet: boolean;
  /** STRIPE_ACCOUNT_ID の前後に空白・改行がある（アプリは取り除いて使う。登録の手がかり） */
  accountIdHasSurroundingWhitespace: boolean;
  /** GET /v1/account：success … 成功・failure … 失敗・not_run … 設定の不足などで問い合わせていない */
  apiAuth: "success" | "failure" | "not_run";
  /** 返ってきた ID と STRIPE_ACCOUNT_ID（前後の空白を除いた、アプリが使う値）の完全一致 */
  accountMatch: "match" | "mismatch" | "not_run";
  /** 不一致のときだけ：末尾4文字と、大文字・小文字だけの違いか */
  mismatchHint: { returnedLast4: string; configuredLast4: string; differsOnlyByCase: boolean } | null;
  error: StripeAccountDiagnosticsError | null;
  checkedAt: string;
};

const last4 = (v: string) => v.slice(-4);

/** Stripe SDK の例外を、画面に出してよい分類だけにする（文言は使わない。キーの末尾が含まれることがあるため） */
export function classifyStripeError(err: unknown): StripeAccountDiagnosticsError {
  const type = err && typeof err === "object" ? (err as { type?: unknown }).type : undefined;
  switch (type) {
    case "StripeAuthenticationError":
      return "stripe_authentication";
    case "StripePermissionError":
      return "stripe_permission";
    case "StripeRateLimitError":
      return "stripe_rate_limit";
    case "StripeConnectionError":
      return "stripe_connection";
    case "StripeAPIError":
      return "stripe_api";
    case "StripeInvalidRequestError":
      return "stripe_invalid_request";
    default:
      return "unknown";
  }
}

/**
 * 診断の本体。呼ぶ前に、運営の認証と isSandboxV2Environment を確かめること（route で行う）。
 * retrieveAccount … 決済の処理と同じ接続（stripeRuntime）で GET /v1/account を呼ぶ関数。設定がそろっているときだけ、1回だけ呼ぶ
 */
export async function runStripeAccountDiagnostics(
  retrieveAccount: () => Promise<unknown>,
  e: Env = process.env,
  now: () => Date = () => new Date(),
): Promise<StripeAccountDiagnosticsResult> {
  const secretKey = (e.STRIPE_SECRET_KEY ?? "").trim();
  const accountRaw = e.STRIPE_ACCOUNT_ID ?? "";
  const base = {
    environment: "sandbox_v2" as const,
    secretKeySet: secretKey !== "",
    secretKeyIsTest: secretKey.startsWith("sk_test_"),
    accountIdSet: accountRaw.trim() !== "",
    webhookSecretSet: (e.STRIPE_WEBHOOK_SECRET ?? "").trim() !== "",
    accountIdHasSurroundingWhitespace: accountRaw !== "" && accountRaw !== accountRaw.trim(),
  };
  const done = (r: Pick<StripeAccountDiagnosticsResult, "apiAuth" | "accountMatch" | "mismatchHint" | "error">): StripeAccountDiagnosticsResult => ({
    ...base,
    ...r,
    checkedAt: now().toISOString(),
  });

  // テスト決済の判定（決済の処理と同じ。テストモード・必要な変数・本番の値の混入なし）。満たさなければ Stripe に問い合わせない
  const cfg = stripeTestConfig(e);
  if (!cfg.ok) return done({ apiAuth: "not_run", accountMatch: "not_run", mismatchHint: null, error: `config_${cfg.reason}` });
  if (!cfg.accountId) return done({ apiAuth: "not_run", accountMatch: "not_run", mismatchHint: null, error: "config_test_account_id_missing" });
  const expected = cfg.accountId;

  let account: unknown;
  try {
    account = await retrieveAccount();
  } catch (err) {
    const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
    return done({ apiAuth: "failure", accountMatch: "not_run", mismatchHint: null, error: name === "StripeUnavailableError" ? "runtime_unavailable" : classifyStripeError(err) });
  }
  const id = account && typeof account === "object" ? (account as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || id === "") return done({ apiAuth: "success", accountMatch: "not_run", mismatchHint: null, error: "invalid_response" });
  if (id === expected) return done({ apiAuth: "success", accountMatch: "match", mismatchHint: null, error: null });
  return done({
    apiAuth: "success",
    accountMatch: "mismatch",
    mismatchHint: { returnedLast4: last4(id), configuredLast4: last4(expected), differsOnlyByCase: id.toLowerCase() === expected.toLowerCase() },
    error: null,
  });
}

/**
 * 診断のレート制限（実行中のサーバーのメモリだけ。Firestore には書かない）。
 * 運営アカウントごとに windowMs の間に perUser 回まで、サーバー全体で global 回まで。同時に実行できるのは1件だけ。
 * サーバーのインスタンスが複数あれば、それぞれで数える（Stripe への問い合わせは1回の診断で1回だけなので、上限は小さく保つ）
 */
export class DiagnosticsRateLimiter {
  private hits: { at: number; user: string }[] = [];
  private running = false;
  constructor(
    private readonly perUser = 3,
    private readonly global = 10,
    private readonly windowMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** 実行してよければ release 関数を返す（終わったら必ず呼ぶ）。だめなら null */
  acquire(user: string): (() => void) | null {
    const t = this.clock();
    this.hits = this.hits.filter((h) => t - h.at < this.windowMs);
    if (this.running) return null;
    if (this.hits.length >= this.global) return null;
    if (this.hits.filter((h) => h.user === user).length >= this.perUser) return null;
    this.hits.push({ at: t, user });
    this.running = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running = false;
    };
  }
}

/** 画面の表示用（値は含めない） */
export const STRIPE_ACCOUNT_DIAGNOSTICS_ERROR_LABEL: Record<string, string> = {
  runtime_unavailable: "Stripe の接続を準備できませんでした（設定の不足）",
  stripe_authentication: "Stripe API の認証に失敗しました（キーが無効・失効・別の環境のもの）",
  stripe_permission: "このキーにはアカウントの取得の権限がありません（制限付きキーの可能性）",
  stripe_rate_limit: "Stripe API の回数の制限にかかりました。少し待ってから再度お試しください",
  stripe_connection: "Stripe API に接続できませんでした（通信の失敗）",
  stripe_api: "Stripe API でエラーが起きました（Stripe 側の一時的な障害の可能性）",
  stripe_invalid_request: "Stripe API がリクエストを受け付けませんでした",
  invalid_response: "Stripe API の応答にアカウントの ID がありませんでした",
  unknown: "原因を分類できないエラーが起きました",
};
