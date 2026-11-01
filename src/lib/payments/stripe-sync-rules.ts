/**
 * Stripe の返金・異議申し立てを決済記録に反映するときの判定（純粋な関数。Firestore・Stripe には触れない。単体テスト用に分けている）。
 * stripe-confirm.ts の syncStripeRefunds・syncStripeDispute が、Stripe API から取り直した値と決済記録の値を渡して使う。
 *
 * ここで決めるのは「何を書き込むか」だけ。書き込み・売上集計のキー（salesKeys）・精算の調整（reconcileTransactionInTx）・
 * 占い権利を止めるかどうかの最終判断（権利の記録があり PAID のときだけ）は、呼び出し側のトランザクションで行う。
 * 日時は呼び出し側から now で渡す（同じ処理の中で同じ値を使う）。
 */
import type Stripe from "stripe";
import { chargebackCoversRemainder, disputeStateOf, type DisputeState } from "./settlement-rules";
import type { CheckoutRefundReason } from "./refunded-notice";
import type { StripeRefundState, StripeRefundSummary } from "./stripe-checkout";

const STRIPE_PROVIDER = "stripe";

const idOfRef = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

/** このアプリの注文の決済か（PaymentIntent の metadata に注文ID・店舗IDを入れている） */
export const isOurPayment = (pi: Pick<Stripe.PaymentIntent, "metadata">) =>
  typeof pi.metadata?.checkoutId === "string" && pi.metadata.checkoutId !== "" && typeof pi.metadata?.storeId === "string";

/** 照合に使う決済記録の項目 */
export type RecordedPaymentFacts = {
  paymentProvider?: unknown;
  stripeChargeId?: unknown;
  livemode?: unknown;
  amount?: unknown;
  storeId?: unknown;
};

/**
 * Stripe の Charge が、記録した決済（取引）と一致するか（返金・異議申し立ての反映の前に確かめる）。
 * 決済ID（Charge・PaymentIntent）、モード（livemode）、金額、通貨、店舗（PaymentIntent の metadata）がすべて一致すること。
 * 一致しない項目名を返す（空なら一致）。値そのものは返さない（決済要確認には項目名だけを記録する）。
 */
export function chargeMismatches(
  t: RecordedPaymentFacts,
  charge: Pick<Stripe.Charge, "id" | "livemode" | "payment_intent" | "currency" | "amount">,
  pi: Pick<Stripe.PaymentIntent, "id" | "livemode" | "amount" | "metadata">,
): string[] {
  const out: string[] = [];
  if (t.paymentProvider !== STRIPE_PROVIDER) out.push("provider");
  if (t.stripeChargeId !== charge.id) out.push("charge_id");
  if (t.livemode !== charge.livemode || pi.livemode !== charge.livemode) out.push("livemode");
  if (idOfRef(charge.payment_intent) !== pi.id) out.push("payment_intent");
  if (charge.currency !== "jpy") out.push("currency");
  if (Number(t.amount) !== charge.amount || pi.amount !== charge.amount) out.push("amount");
  if (pi.metadata?.storeId !== String(t.storeId)) out.push("store");
  return out;
}

// ---------- 返金 ----------

/** 返金の状態のキー（同じ値なら反映済み。通知の再送・重複では書き込まない） */
export const refundKeyOf = (s: StripeRefundSummary) => `${s.state}:${s.succeededAmount}:${s.pendingAmount}:${s.failedAmount}:${s.refundIds.join(",")}`;

export type StripeRefundSyncOutcome = "refund_pending" | "refunded" | "partial" | "refund_failed";

/**
 * 返金の状態で、未使用の占い権利を止めるか（決済確定の前後で同じ規則）。
 * 処理中・成功・一部の返金で止める。失敗（すべて失敗・取り消し）では止めない（管理者が確認する）。
 * 止めた権利は自動では戻さない（運営の理由付きの操作だけ。decideEntitlementRestore）。
 */
export const refundSuspendsEntitlement = (state: StripeRefundState) => state === "succeeded" || state === "pending" || state === "partial";

export type RefundTxFacts = { paymentStatus: unknown; refundKey: unknown };

export type RefundSyncDecision =
  | { kind: "unchanged" }
  | {
      kind: "apply";
      outcome: StripeRefundSyncOutcome;
      /** 返金の項目（決済の状態の変更・売上集計のキー・精算の調整・updatedAt は含まない） */
      fields: Record<string, unknown>;
      /** 決済の状態が変わるとき（呼び出し側で salesKeys を合わせて書き込む）。変わらなければ null */
      statusChange: { paymentStatus: "SUCCEEDED" | "REFUNDED" | "CHARGEBACK"; refundedAt: Date | null } | null;
      suspendEntitlement: boolean;
    };

/**
 * 返金の状態（Stripe API の返金の一覧から求めたもの）を、決済記録にどう反映するか。
 * 状態が "none"（返金が無い）のときは呼び出し側で扱う（反映しない）。
 */
export function decideRefundSync(t: RefundTxFacts, summary: StripeRefundSummary, now: Date): RefundSyncDecision {
  const refundKey = refundKeyOf(summary);
  if (t.refundKey === refundKey) return { kind: "unchanged" }; // 同じ状態はもう反映済み（再送・重複）
  const refunded = summary.state === "succeeded";
  const needsReview = summary.state === "partial" || summary.state === "failed";
  const paymentStatus = refunded ? "REFUNDED" : "SUCCEEDED"; // 成功した返金が後で失敗に変わったら SUCCEEDED に戻す
  // 異議申し立てで敗訴（全額）した決済は CHARGEBACK のまま（返金の状態だけ記録する）
  const nextStatus = t.paymentStatus === "CHARGEBACK" ? "CHARGEBACK" : paymentStatus;
  const fields: Record<string, unknown> = {
    refundStatus: summary.state,
    refundKey,
    amountRefunded: summary.succeededAmount,
    refundPendingAmount: summary.pendingAmount,
    refundFailedAmount: summary.failedAmount,
    stripeRefundIds: summary.refundIds,
    refundNeedsReview: needsReview,
    refundUpdatedAt: now,
  };
  const outcome: StripeRefundSyncOutcome = refunded ? "refunded" : summary.state === "pending" ? "refund_pending" : summary.state === "partial" ? "partial" : "refund_failed";
  return {
    kind: "apply",
    outcome,
    fields,
    statusChange: t.paymentStatus !== nextStatus ? { paymentStatus: nextStatus, refundedAt: refunded ? now : null } : null,
    suspendEntitlement: refundSuspendsEntitlement(summary.state),
  };
}

// ---------- 異議申し立て ----------

export type DisputeFacts = Pick<Stripe.Dispute, "id" | "amount" | "currency" | "status" | "reason">;

/** 異議申し立ての状態のキー（同じ値なら反映済み） */
export const disputeKeyOf = (dp: Pick<DisputeFacts, "id" | "status" | "amount">) => `${dp.id}:${dp.status}:${dp.amount}`;

/**
 * 異議申し立ての金額・通貨が決済と合わないか（合わなければ反映しない）。
 * 問題の項目名（"currency" | "amount"）を返す。問題が無ければ null。
 */
export function disputeAmountProblem(dp: Pick<DisputeFacts, "amount" | "currency">, chargeAmount: number): "currency" | "amount" | null {
  if (dp.currency !== "jpy" || !Number.isSafeInteger(dp.amount) || dp.amount <= 0 || dp.amount > chargeAmount) return dp.currency !== "jpy" ? "currency" : "amount";
  return null;
}

/**
 * 異議申し立ての状態で、未使用の占い権利を止めるか。
 * 今の規則：敗訴だけ止める（対応中・勝訴では止めない）。
 */
export const disputeSuspendsEntitlement = (state: DisputeState) => state === "lost";

export type StripeDisputeSyncOutcome = "dispute_open" | "dispute_won" | "dispute_lost";

export type DisputeTxFacts = {
  disputeId: unknown;
  disputeStatus: unknown;
  disputeKey: unknown;
  paymentStatus: unknown;
  amount: unknown;
  amountRefunded: unknown;
  refundStatus: unknown;
};

export type DisputeSyncDecision =
  /** 同じ決済に別の異議申し立て（通常は起きない）：自動では反映しない */
  | { kind: "multiple_disputes" }
  /** 結果が出た申し立てが対応中に戻った（古い状態の取り直し・順番の入れ替わり）：反映しない */
  | { kind: "regressed" }
  | { kind: "unchanged" }
  | {
      kind: "apply";
      state: DisputeState;
      outcome: StripeDisputeSyncOutcome;
      /** 異議申し立ての項目（決済の状態の変更・売上集計のキー・精算の調整・updatedAt は含まない） */
      fields: Record<string, unknown>;
      /** 決済の状態が変わるとき（呼び出し側で salesKeys を合わせて書き込む）。変わらなければ null */
      statusChange: { paymentStatus: string; chargebackAt: Date | null } | null;
      suspendEntitlement: boolean;
    };

/** 異議申し立ての状態（Stripe API から取り直したもの。金額は disputeAmountProblem で確認済み）を、決済記録にどう反映するか */
export function decideDisputeSync(t: DisputeTxFacts, dp: DisputeFacts, now: Date): DisputeSyncDecision {
  const state = disputeStateOf(String(dp.status));
  const prevId = t.disputeId;
  const prevState = t.disputeStatus;
  if (typeof prevId === "string" && prevId && prevId !== dp.id) return { kind: "multiple_disputes" };
  if ((prevState === "won" || prevState === "lost") && state === "open") return { kind: "regressed" };
  const key = disputeKeyOf(dp);
  if (t.disputeKey === key) return { kind: "unchanged" };
  const cur = String(t.paymentStatus);
  const full = chargebackCoversRemainder({ amount: Number(t.amount), amountRefunded: Number(t.amountRefunded ?? 0), disputeStatus: state, disputeAmount: dp.amount });
  const refundedAll = t.refundStatus === "succeeded";
  const nextStatus = state === "lost" && full ? "CHARGEBACK" : cur === "CHARGEBACK" ? (refundedAll ? "REFUNDED" : "SUCCEEDED") : cur;
  const fields: Record<string, unknown> = {
    disputeId: dp.id,
    disputeStatus: state,
    disputeStripeStatus: String(dp.status),
    disputeAmount: dp.amount,
    disputeReason: String(dp.reason ?? ""),
    disputeKey: key,
    disputeNeedsReview: state !== "won",
    disputeUpdatedAt: now,
  };
  const outcome: StripeDisputeSyncOutcome = state === "lost" ? "dispute_lost" : state === "won" ? "dispute_won" : "dispute_open";
  return {
    kind: "apply",
    state,
    outcome,
    fields,
    statusChange: nextStatus !== cur ? { paymentStatus: nextStatus, chargebackAt: nextStatus === "CHARGEBACK" ? now : null } : null,
    suspendEntitlement: disputeSuspendsEntitlement(state),
  };
}

// ---------- 決済確定の時点の占い権利 ----------

export type InitialEntitlement = {
  /** 占い権利を有効（PAID）で作るか */
  grant: boolean;
  /** 注文の状態（権利を付与しないときは REFUNDED） */
  checkoutStatus: "SUCCEEDED" | "REFUNDED";
  /** REFUNDED の理由（返金か、異議申し立ての敗訴か）。付与するときは null */
  refundReason: CheckoutRefundReason | null;
  suspendedByRefund: boolean;
  suspendedByDispute: boolean;
};

/**
 * 決済確定の時点で、Stripe にもう返金・異議申し立てがあるときの占い権利（確定の後に届いた場合と同じ規則）。
 * 返金（処理中・成功・一部）または異議申し立ての敗訴があれば、権利を最初から止めて作り、注文を REFUNDED にする。
 * 敗訴があれば理由は chargeback（返金もあるときも chargeback を優先する）。異議申し立ての対応中・勝訴、返金の失敗では付与する。
 */
export function initialEntitlementOf(refundState: StripeRefundState, disputeState: DisputeState | null): InitialEntitlement {
  const suspendedByRefund = refundSuspendsEntitlement(refundState);
  const suspendedByDispute = disputeState !== null && disputeSuspendsEntitlement(disputeState);
  const grant = !suspendedByRefund && !suspendedByDispute;
  return {
    grant,
    checkoutStatus: grant ? "SUCCEEDED" : "REFUNDED",
    refundReason: suspendedByDispute ? "chargeback" : suspendedByRefund ? "refund" : null,
    suspendedByRefund,
    suspendedByDispute,
  };
}

// ---------- 止めた占い権利の復旧（運営の操作） ----------

/** 復旧の理由の最大の長さ（文字数） */
export const RESTORE_REASON_MAX = 200;

export type RestoreFacts = {
  paymentStatus: unknown;
  refundStatus: unknown;
  disputeStatus: unknown;
  entitlement: { exists: boolean; status?: unknown; suspendedByRefund?: unknown; suspendedByDispute?: unknown; usedAt?: unknown };
};

export type RestoreDenyReason =
  | "payment_not_succeeded"
  | "refund_pending"
  | "refund_not_restorable"
  | "dispute_open"
  | "dispute_lost"
  | "entitlement_missing"
  | "entitlement_used"
  | "entitlement_not_suspended"
  | "entitlement_suspended_by_dispute"
  | "reason_required"
  | "reason_too_long";

export type RestoreDecision = { ok: true; refundState: "failed" | "partial"; reason: string } | { ok: false; deny: RestoreDenyReason };

/** 理由の入力を整える（制御文字は空白にし、前後の空白を除く） */
export const normalizeRestoreReason = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "");

/**
 * 返金で止めた占い権利を、運営が戻してよいか（呼び出し側は Stripe API で返金の状態を反映してから、トランザクションの中で判定する）。
 * 戻せるのは次のすべてを満たすときだけ：
 *  - 決済が SUCCEEDED（全額の返金 REFUNDED・チャージバック CHARGEBACK は戻さない）
 *  - 返金がすべて失敗・取り消し（failed）か、一部の返金（partial）。処理中・成功は戻さない
 *  - 異議申し立てが対応中・敗訴でない
 *  - 権利があり、未使用で、返金で止めたもの（異議申し立てで止めたものは戻さない）
 *  - 理由が入力されている（RESTORE_REASON_MAX 文字まで。監査ログに残す）
 */
export function decideEntitlementRestore(f: RestoreFacts, reasonInput: unknown): RestoreDecision {
  if (f.paymentStatus !== "SUCCEEDED") return { ok: false, deny: "payment_not_succeeded" };
  if (f.refundStatus === "pending") return { ok: false, deny: "refund_pending" };
  if (f.refundStatus !== "failed" && f.refundStatus !== "partial") return { ok: false, deny: "refund_not_restorable" };
  if (f.disputeStatus === "open") return { ok: false, deny: "dispute_open" };
  if (f.disputeStatus === "lost") return { ok: false, deny: "dispute_lost" };
  const e = f.entitlement;
  if (!e.exists) return { ok: false, deny: "entitlement_missing" };
  if (e.status === "USED" || e.usedAt) return { ok: false, deny: "entitlement_used" };
  if (e.suspendedByDispute === true) return { ok: false, deny: "entitlement_suspended_by_dispute" };
  if (e.status !== "EXPIRED" || e.suspendedByRefund !== true) return { ok: false, deny: "entitlement_not_suspended" };
  const reason = normalizeRestoreReason(reasonInput);
  if (!reason) return { ok: false, deny: "reason_required" };
  if ([...reason].length > RESTORE_REASON_MAX) return { ok: false, deny: "reason_too_long" };
  return { ok: true, refundState: f.refundStatus, reason };
}

// ---------- 決済確定の時点の決済記録の状態 ----------

export type ConfirmState = {
  /** 決済記録の状態（売上集計のキーは呼び出し側でこの値から求める） */
  paymentStatus: string;
  /** 決済記録に書き込む返金・異議申し立ての項目（返金日時・チャージバック日時を含む）。何も無ければ空 */
  fields: Record<string, unknown>;
  entitlement: InitialEntitlement;
};

/**
 * 決済確定の時点で Stripe にもう返金・異議申し立てがあるときの、決済記録・注文・占い権利の初期の状態。
 * 確定の後に「返金 → 異議申し立て」の順に通知が届いたときと同じ結果にする（decideRefundSync・decideDisputeSync を
 * まだ何も反映していない決済記録に順に当てはめる）。権利は initialEntitlementOf の規則で、最初から止めて作るかを決める。
 * dispute は金額・通貨を disputeAmountProblem で確認済みのもの（1件まで）。
 */
export function decideConfirmState(amount: number, refunds: StripeRefundSummary, dispute: DisputeFacts | null, now: Date): ConfirmState {
  let paymentStatus = "SUCCEEDED";
  const fields: Record<string, unknown> = {};
  if (refunds.state !== "none") {
    const r = decideRefundSync({ paymentStatus, refundKey: undefined }, refunds, now);
    if (r.kind === "apply") {
      Object.assign(fields, r.fields);
      if (r.statusChange) {
        paymentStatus = r.statusChange.paymentStatus;
        fields.refundedAt = r.statusChange.refundedAt;
      }
    }
  }
  let disputeState: DisputeState | null = null;
  if (dispute) {
    const d = decideDisputeSync(
      { disputeId: undefined, disputeStatus: undefined, disputeKey: undefined, paymentStatus, amount, amountRefunded: refunds.succeededAmount, refundStatus: refunds.state === "none" ? null : refunds.state },
      dispute,
      now,
    );
    if (d.kind === "apply") {
      Object.assign(fields, d.fields);
      disputeState = d.state;
      if (d.statusChange) {
        paymentStatus = d.statusChange.paymentStatus;
        fields.chargebackAt = d.statusChange.chargebackAt;
      }
    }
  }
  return { paymentStatus, fields, entitlement: initialEntitlementOf(refunds.state, disputeState) };
}

// ---------- 返金・異議申し立ての反映の後の注文の状態 ----------

/**
 * 決済の今の状態（反映の後の返金・異議申し立て）から、注文を REFUNDED にすべき理由。止めるべきでなければ null。
 * 権利を止める規則（refundSuspendsEntitlement・disputeSuspendsEntitlement）と同じ。敗訴があれば chargeback を優先する。
 */
export function checkoutRefundReasonOf(refundStatus: unknown, disputeStatus: unknown): CheckoutRefundReason | null {
  if (disputeStatus === "lost") return "chargeback";
  if (refundStatus === "pending" || refundStatus === "succeeded" || refundStatus === "partial") return "refund";
  return null;
}

/**
 * 返金・異議申し立ての反映（決済記録の更新と同じトランザクション）で、注文の状態をどう変えるか。変えなければ null。
 *  - 決済の今の状態が返金（処理中・成功・一部）か敗訴なら、SUCCEEDED の注文を REFUNDED にする（理由も今の状態に合わせる）
 *  - REFUNDED から SUCCEEDED には戻さない（返金の失敗・勝訴でも自動では戻さない。権利の復旧は運営の操作だけ）
 *  - SUCCEEDED・REFUNDED 以外の注文（決済記録と紐付いていないもの）は変えない
 *  - 反映の後も占い権利が有効（PAID）のままなら変えない（運営が理由付きで戻した権利に、止めない通知（対応中の異議申し立てなど）が
 *    届いたとき。注文と権利の状態をそろえる。権利を止める通知なら、権利と一緒に REFUNDED にする）
 */
export function decideCheckoutAfterSync(
  cur: { status: unknown; refundReason: unknown },
  after: { refundStatus: unknown; disputeStatus: unknown; entitlementActive?: boolean },
): { status: "REFUNDED"; refundReason: CheckoutRefundReason } | null {
  if (after.entitlementActive) return null;
  const reason = checkoutRefundReasonOf(after.refundStatus, after.disputeStatus);
  if (!reason) return null;
  if (cur.status !== "SUCCEEDED" && cur.status !== "REFUNDED") return null;
  if (cur.status === "REFUNDED" && cur.refundReason === reason) return null;
  return { status: "REFUNDED", refundReason: reason };
}

/** 復旧の操作の結果（decideEntitlementRestore の理由に、Stripe・決済の照合の結果を加えたもの） */
export type RestoreOutcomeCode = "restored" | RestoreDenyReason | "not_eligible" | "payment_mismatch" | "stripe_unavailable" | "stripe_unverified" | "state_changed";

/** 復旧に成功したときの通知（決済履歴の画面の上部に表示する。決済ID・理由などは含めない） */
export const RESTORE_SUCCESS_NOTICE = "占い権利を復旧しました（有効期限は復旧時から24時間）";

/** 運営画面に出す説明（お客さんには表示しない。理由の入力の内容は含めない） */
export const RESTORE_OUTCOME_MESSAGE: Record<RestoreOutcomeCode, string> = {
  restored: RESTORE_SUCCESS_NOTICE,
  payment_not_succeeded: "全額の返金済み・チャージバックの決済のため、戻せません。",
  refund_pending: "返金の処理中のため、戻せません（Stripe で返金の結果が出るまでお待ちください）。",
  refund_not_restorable: "返金がすべて失敗・一部の返金のときだけ戻せます。",
  dispute_open: "異議申し立て（チャージバック）の対応中のため、戻せません。",
  dispute_lost: "異議申し立て（チャージバック）で敗訴した決済のため、戻せません。",
  entitlement_missing: "占い権利の記録がありません。",
  entitlement_used: "占い権利は使用済みのため、戻せません。",
  entitlement_not_suspended: "戻せる占い権利がありません（返金で止めたものではない・すでに戻した、など）。",
  entitlement_suspended_by_dispute: "異議申し立てで止めた占い権利のため、戻せません。",
  reason_required: "戻す理由を入力してください。",
  reason_too_long: `戻す理由は${RESTORE_REASON_MAX}文字以内で入力してください。`,
  not_eligible: "この決済の占い権利は戻せません。",
  payment_mismatch: "Stripe の決済と記録・注文が一致しないため、戻せません。",
  stripe_unavailable: "Stripe で返金・異議申し立ての状態を確認できませんでした。少し時間をおいてから、もう一度お試しください。",
  stripe_unverified: "Stripe の返金・異議申し立ての状態を確認できない内容があるため、戻せません（決済要確認を確認してください）。",
  state_changed: "確認の途中で返金・異議申し立ての状態が変わりました。画面を開き直して、もう一度確認してください。",
};

/**
 * 決済確定の後の再確認の状態（決済記録の recheckState）。
 *  PENDING … 決済記録を作成したトランザクションで保存する。作成の後に Stripe の返金・異議申し立てを読み直し、
 *            読み取り・検証・必要な反映がすべて成功するまで維持する（失敗・途中の停止では変えない）
 *  DONE    … 作成の後に Stripe を読み直し、必要な反映がすべて成功した。この後の返金・異議申し立ては、それぞれの通知で反映する
 *            （DONE の後の通知の取りこぼしは、この仕組みでは防げない）
 *  UNKNOWN … 項目が無い（この仕組みより前に作成された決済記録）。再確認の対象にはしないが、再確認が済んだことは意味しない
 * PENDING・DONE 以外の値が入っていたら、安全側で PENDING として扱う（再確認をやり直すだけで、反映は冪等）。
 */
export const RECHECK_PENDING = "PENDING" as const;
export const RECHECK_DONE = "DONE" as const;
export type RecheckState = typeof RECHECK_PENDING | typeof RECHECK_DONE | "UNKNOWN";
export const recheckStateOf = (v: unknown): RecheckState => (v === undefined || v === null ? "UNKNOWN" : v === RECHECK_DONE ? RECHECK_DONE : RECHECK_PENDING);

/**
 * 再確認で実行した反映の結果から、完了にできない理由を返す（null なら完了にしてよい）。
 * 「反映しなかった」結果（記録と照合できない rejected・対象外の ignored）があれば完了にしない（PENDING のまま、運営が確認する）。
 */
export function recheckFailureOf(outcomes: readonly string[]): string | null {
  const bad = outcomes.find((o) => o === "rejected" || o === "ignored");
  return bad ? `sync_${bad}` : null;
}
