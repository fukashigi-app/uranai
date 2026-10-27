/**
 * 決済監視の点検を手動で1回実行する（読み取り専用。決済の確定・返金・再決済はしない）。
 * 見つかった異常は決済監視（paymentAlerts）に記録し、点検の結果を system/paymentMonitor に残す（運営画面「決済監視」に表示）。
 *
 *   npm run monitor:payments
 *
 * 今はローカルの Firestore Emulator（demo- のプロジェクト）だけで実行できる。
 * 定期実行（Vercel Cron など）・外部への通知はまだ設定していない。本番で使う前に、接続先・実行の間隔・通知先を決めること。
 * 出力は件数・確認できなかった項目だけ（決済ID・個人情報・秘密鍵は出さない）。
 */
import "dotenv/config";

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !(process.env.FIREBASE_PROJECT_ID ?? "demo-uranai").startsWith("demo-")) {
    console.error("決済監視の点検は、今はローカルの Firestore Emulator（demo- のプロジェクト）でだけ実行できます。FIRESTORE_EMULATOR_HOST を設定してください。");
    process.exit(2);
  }
  if (process.env.DB_PROVIDER === "postgres") {
    console.error("決済監視の点検は Firestore を使うときだけ実行できます。");
    process.exit(2);
  }
  const { runPaymentMonitor } = await import("@/lib/payments/payment-monitor");
  const run = await runPaymentMonitor({ source: "script" });
  if (!run.started) {
    console.error(run.reason === "busy" ? `ほかの点検を実行中のため、開始しませんでした（遅くとも ${run.heldUntil?.toISOString() ?? "不明"} に終わります）。` : "点検の実行状態を記録できなかったため、点検を開始しませんでした。異常の有無は確認できていません。");
    process.exit(4);
  }
  const r = run.report;
  const label = { ok: "異常なし（確認したすべての項目）", issues: "異常あり", partial: "一部を確認できなかった（異常なしとは言えない）", failed: "点検に失敗" }[r.result];
  console.log(`結果: ${label}`);
  console.log(`見つかった異常: ${r.found}件 / 未確認の決済要確認: ${r.openReviews}件 / Stripe の接続: ${r.stripeMode ?? "なし"}`);
  console.log(`件数: ${JSON.stringify(r.checks)}`);
  if (r.unchecked.length) console.log(`確認できなかった項目: ${r.unchecked.join("・")}`);
  process.exit(r.result === "ok" ? 0 : 1);
}

main().catch((e) => {
  console.error("[payment-monitor] failed", (e as Error)?.name);
  process.exit(3);
});
