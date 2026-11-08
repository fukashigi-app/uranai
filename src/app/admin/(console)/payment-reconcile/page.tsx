import { Card, PageHeader } from "@/components/console/shell";
import { PaymentReconcilePanel, type ReconcileLabels } from "@/components/console/payment-reconcile-panel";
import { requireOperator } from "@/lib/auth/session";
import { isFirestore } from "@/lib/data-provider";
import { RECONCILE_ANOMALY_LABEL, RECONCILE_DETAIL_LABEL, RECONCILE_GRACE_MS, RECONCILE_PENDING_LABEL, RECONCILE_REVIEW_LABEL } from "@/lib/payments/reconcile-rules";
import { RECONCILE_STOP_LABEL } from "@/lib/payments/stripe-reconcile";

export const metadata = { title: "決済照合" };
export const dynamic = "force-dynamic";

const ERROR_LABEL: Record<string, string> = {
  rate_limited: "ほかの照合を実行中か、実行の回数の上限に達しました。1分ほど待ってから再度お試しください。",
  invalid_range: "期間の指定が正しくありません。",
  range_too_long: "期間は最長31日です。",
  range_future: "開始日が未来です。",
  invalid_request: "要求の形が正しくありません。",
  invalid_token: "続きの位置を確認できませんでした。最初から照合してください。",
  expired_token: "開始から2時間を過ぎたため、続きから再開できません。最初から照合してください。",
  token_user_mismatch: "別の運営アカウントで始めた照合は再開できません。最初から照合してください。",
  token_environment_mismatch: "照合を始めたときと Stripe の接続・環境が違うため、再開できません。最初から照合してください。",
  already_done: "この照合はすでに最後まで終わっています。",
  secret_unavailable: "サーバーの設定（SESSION_SECRET）が不足しているため、照合できません。",
  firestore_required: "この機能は Firestore を使うときだけ利用できます。",
  stripe_unavailable: "この環境では Stripe に接続できないため、照合できません。",
  too_large: "要求が大きすぎます。最初から照合してください。",
  unknown: "照合を実行できませんでした。異常の有無は確認できていません。",
};

/**
 * 決済照合（F2 第1段階）：Stripe の決済の一覧を起点に、Firestore の注文・取引と照合する（読み取り専用）。
 * 注文そのものが消えた決済・Webhook が届かなかった決済も見つけられる（決済監視は Firestore の注文が起点）。
 * 返金・異議申し立て・精算の照合は第2段階（この画面では扱わない）。自動の修正・返金・決済要確認への登録はしない。
 */
export default async function PaymentReconcilePage() {
  await requireOperator();
  if (!isFirestore()) {
    return (
      <>
        <PageHeader title="決済照合" />
        <Card>
          <p className="text-[13px] text-ink-muted">この機能は Firestore を使うときだけ利用できます。</p>
        </Card>
      </>
    );
  }
  let mode: "test" | "live" | null = null;
  try {
    const { stripeRuntime } = await import("@/lib/payments/stripe-checkout");
    mode = stripeRuntime().mode;
  } catch {
    mode = null;
  }
  const labels: ReconcileLabels = { kind: RECONCILE_ANOMALY_LABEL, detail: RECONCILE_DETAIL_LABEL, stop: RECONCILE_STOP_LABEL, error: ERROR_LABEL, review: RECONCILE_REVIEW_LABEL, pending: RECONCILE_PENDING_LABEL };
  return (
    <>
      <PageHeader
        title="決済照合"
        description={`Stripe の決済（PaymentIntent）の一覧を起点に、この環境の支払い済みの決済が、注文・取引の記録と一致しているかを照合します（読み取りのみ）。支払いから${Math.round(RECONCILE_GRACE_MS / 60_000)}分以内で記録がまだ無いものは「処理待ち」として異常にしません。あわせて、返金・異議申し立て（元の決済が期間の外でも、期間の中に作られたもの）と、確定済みの店舗精算の調整を照合します。異常が見つかっても自動では修正・返金・精算しません。Firestore にだけある取引の照合はまだ含みません。`}
      />
      <Card title="照合する">
        <PaymentReconcilePanel mode={mode} labels={labels} />
      </Card>
    </>
  );
}
