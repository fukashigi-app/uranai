# Stripe の決済・返金・異議申し立て：仕様と運用

Stripe Checkout の決済・返金・異議申し立て（チャージバック）・占い権利・売上と手数料の集計・店舗精算の仕様と、運営の操作の手順です。
内容はすべて、`feature/stripe-checkout` ブランチのコミット `d510102` の時点のコードとテストで確かめたものです（推測は書いていません）。

- 全体の設計は [ARCHITECTURE.md](ARCHITECTURE.md)、Vercel の Preview・Stripe の Sandbox での確認の手順は [preview-verification.md](preview-verification.md) を参照
- **本番の Stripe 決済（Live）は未実装・無効です。** この文書の「本番の決済」は、自動テストの模擬（本番モードの模擬 Stripe と Firestore Emulator）で確かめた動作です

状態の表記：

| 表記 | 意味 |
| --- | --- |
| **実装済み・テスト済み** | コードがあり、単体テストまたは E2E（ローカルの Emulator と模擬 Stripe）で確かめた |
| **実装済み・未検証** | コードはあるが、テストで確かめていない部分がある |
| **未実装** | コードが無い |
| **未検証（実環境）** | 模擬では確かめたが、本物の Stripe・本番の環境では確かめていない |

---

## 1. 決済の状態と占い権利の仕様

### 1.1 3つの記録

| 記録（Firestore） | 内容 | 1つの決済につき |
| --- | --- | --- |
| `checkouts/{注文ID}` | 注文。`status`：`CREATED`・`PROCESSING`・`SUCCEEDED`・`FAILED`・`EXPIRED`・`REFUNDED`。`REFUNDED` のときは `refundReason`（`refund` / `chargeback`） | 1件 |
| `transactions/stripe_{PaymentIntent}` | 決済記録。`paymentStatus`：`SUCCEEDED`・`REFUNDED`・`CHARGEBACK`。返金（`refundStatus` など）・異議申し立て（`disputeStatus` など）・手数料・売上と手数料の集計のキー | 1件（ID が PaymentIntent で決まる） |
| `fortuneSessions/{決済記録のID}` | 占い権利。`status`：`PAID`（使える）・`USED`（使用済み）・`EXPIRED`（期限切れ・停止）。停止の理由は `suspendedByRefund` / `suspendedByDispute` | 1件 |

- `REFUNDED` の注文の状態は Firestore だけにあります（Stripe の決済は Firestore だけで動くため、PostgreSQL の `checkout_status` には追加していません）
- 関連するコード：`src/lib/payments/stripe-confirm.ts`、`src/lib/firestore/payments.ts`（注文の型）、`src/lib/payments/refunded-notice.ts`（理由と案内）

### 1.2 決済の状態ごとの扱い（決済確定の前に起きた場合も、後に起きた場合も同じ規則）

| Stripe の状態 | 決済記録 `paymentStatus` | 売上 | 占い権利（未使用なら） | 注文 |
| --- | --- | --- | --- | --- |
| 決済成功（返金・異議申し立てなし） | `SUCCEEDED` | 数える | `PAID` | `SUCCEEDED` |
| 返金の処理中 | `SUCCEEDED`（売上・精算は減らさない） | 数える | **停止**（返金で停止） | `REFUNDED`（`refund`） |
| 一部の返金 | `SUCCEEDED`（返金の後の額で集計・管理者の確認が必要） | 返金の後の額 | **停止**（返金で停止） | `REFUNDED`（`refund`） |
| 全額の返金 | `REFUNDED` | 数えない | **停止**（返金で停止） | `REFUNDED`（`refund`） |
| 返金がすべて失敗・取り消し | `SUCCEEDED`（管理者の確認が必要） | 数える | 確定の前なら `PAID`。停止の後なら**停止のまま**（自動では戻さない） | 確定の前なら `SUCCEEDED`。停止の後なら `REFUNDED` のまま |
| 異議申し立ての対応中 | `SUCCEEDED`（申し立ての額の分だけ精算を保留） | 数える | `PAID`（止めない） | `SUCCEEDED` |
| 異議申し立ての勝訴 | `SUCCEEDED`（保留を解除） | 数える | 変えない | 変えない |
| 異議申し立ての敗訴（返金の後の残りすべて） | `CHARGEBACK` | 数えない | **停止**（異議申し立てで停止） | `REFUNDED`（`chargeback`） |
| 異議申し立ての敗訴（一部の額） | `SUCCEEDED`（残りの額だけ売上・取り分に残す） | 残りの額 | **停止**（異議申し立てで停止） | `REFUNDED`（`chargeback`） |

- 返金と敗訴の両方があるとき、注文の理由は `chargeback` を優先します
- 使用済み（`USED`）の権利はそのままです。ただし返金・敗訴の決済の注文は `REFUNDED` にします（結果の再表示は権利の記録で行うので影響なし）
- 運営が理由付きで戻した権利（`PAID`）に、権利を止めない通知（対応中の異議申し立てなど）が届いても、注文は `SUCCEEDED` のままにします。権利を止める通知なら、権利と注文を一緒に止めます
- **実装済み・テスト済み**
  - 規則（純粋な関数）：`src/lib/payments/stripe-sync-rules.ts`（`decideRefundSync`・`decideDisputeSync`・`refundSuspendsEntitlement`・`disputeSuspendsEntitlement`・`initialEntitlementOf`・`decideConfirmState`・`checkoutRefundReasonOf`・`decideCheckoutAfterSync`）、`src/lib/payments/settlement-rules.ts`
  - 反映：`src/lib/payments/stripe-confirm.ts`（`confirmStripeCheckout`・`syncStripeRefunds`・`syncStripeDispute`）
  - テスト：`tests/stripe-sync-rules.test.ts`、`tests/stripe-confirm-adjustments.test.ts`、`tests/settlement-rules.test.ts`、`scripts/e2e-stripe.ts`（場面7、後半の場面12〜15）、`scripts/e2e-stripe-ordering.ts`、`scripts/e2e-stripe-settlement.ts`

### 1.3 注文・決済記録・占い権利の状態の変わり方

```
注文: CREATED ──決済画面へ──▶ PROCESSING ──決済確定──▶ SUCCEEDED ⇄ REFUNDED
                     │                      │                    ▲        │
                     │                      │（確定の時点で返金・敗訴） │        │運営の理由付きの復旧だけ
                     │                      └────────────────▶ REFUNDED ─┘
                     ├─ Session の期限切れ ─▶ EXPIRED
                     └─ PaymentIntent の取り消し・非同期の支払いの失敗 ─▶ FAILED
```

- **REFUNDED から SUCCEEDED に戻るのは、運営の理由付きの復旧の操作（`restoreStripeEntitlement`）だけ**です。返金の失敗・勝訴・古い通知・再送・毎日の定期処理では戻りません
- 毎日の定期処理（`src/lib/firestore/misc.ts`）が期限切れにするのは、未払いの `CREATED`・`FAILED` の注文だけです。`REFUNDED` は書き換えず、削除もしません
- 権利・注文・決済記録の更新は、同じ Firestore のトランザクションで行います（途中で失敗すると、どれも書き込まれない）
- **実装済み・テスト済み**：`tests/refunded-checkout.test.ts`、`scripts/e2e-stripe.ts`（後半の場面12〜14）、`scripts/e2e-stripe-ordering.ts`（各操作の後に不変条件を確認）

### 1.4 お客さんの画面（REFUNDED の注文）

| 画面・API | 動作 |
| --- | --- |
| 決済画面（`/payment`） | 返金の案内を出し、決済のボタンは出さない |
| 決済画面への移動（`POST /api/checkout/stripe-session`） | 410（コード `refunded`） |
| 戻り先（`/payment/return`） | 返金の案内（チャージバックはチャージバックの案内）。占いの入力へ移動しない |
| 状態の確認（`GET /api/checkout/status`） | `{ status: "refunded", refundReason }` |
| 占い（`POST /api/fortune`） | 410（権利が `PAID` ではない） |

- どの案内にも「請求は発生していません」とは書きません（支払いは発生している）
- **実装済み・テスト済み**：`src/lib/payments/refunded-notice.ts`、`src/app/payment/page.tsx`、`src/app/payment/return/page.tsx`、`src/components/public/stripe-return-status.tsx`、`scripts/e2e-stripe.ts`（後半の場面12・13）

### 1.5 運営が占い権利を復旧できる条件

`restoreStripeEntitlement`（`src/lib/payments/stripe-confirm.ts`）と、その判定 `decideEntitlementRestore`（`src/lib/payments/stripe-sync-rules.ts`）。

**復旧できる（次のすべて）：**
- 決済記録が `SUCCEEDED`
- 返金がすべて失敗・取り消し（`failed`）か、一部の返金（`partial`）
- 異議申し立てが対応中・敗訴でない
- 権利があり、未使用で、返金で止めたもの（`EXPIRED`・`suspendedByRefund`）
- 理由が入力されている（制御文字は空白にし、前後の空白を除いて1〜200文字）

**復旧できない（結果のコード）：**

| 状態 | コード |
| --- | --- |
| 全額の返金・チャージバック | `payment_not_succeeded` |
| 返金の処理中 | `refund_pending` |
| 返金が無い・返金が成功 | `refund_not_restorable` |
| 異議申し立ての対応中・敗訴 | `dispute_open` / `dispute_lost` |
| 権利が無い・使用済み・止めていない（戻し済み） | `entitlement_missing` / `entitlement_used` / `entitlement_not_suspended` |
| 異議申し立てで止めた権利 | `entitlement_suspended_by_dispute` |
| 理由が無い・長すぎる | `reason_required` / `reason_too_long` |
| モードの違う決済・ID の形が違う | `not_eligible` |
| Stripe の決済と記録・注文が一致しない | `payment_mismatch` |
| Stripe API の取得の失敗 | `stripe_unavailable` |
| 検証できない内容（複数の異議申し立て・通貨の食い違いなど） | `stripe_unverified` |
| 確認の途中で返金・異議申し立ての状態が変わった | `state_changed` |

**処理の順序：**
1. 決済記録のモード・理由の入力を確かめる（Stripe に問い合わせる前）
2. Stripe API から Charge・PaymentIntent・返金・異議申し立ての最新の状態を取得・検証し、決済記録と照合する
3. 最新の状態を決済記録に反映する（Webhook が遅れていても、Stripe の今の状態で判断する）
4. 1つのトランザクションで：記録の状態が手順2で確かめた状態と同じことを確認し、条件を判定し、権利を `PAID`（有効期限は24時間）、注文を `SUCCEEDED` にし、監査ログ（`stripe_test.entitlement_restored`：運営・理由・復旧の前後の状態・返金の状態と額）を記録する

- 同時に・2回操作しても、成功は1回だけです（監査ログも1件）
- 理由は監査ログだけに残し、お客さんの画面には表示しません
- **実装済み・テスト済み**：`tests/stripe-sync-rules.test.ts`、`tests/admin-restore-action.test.ts`、`scripts/e2e-stripe.ts`（場面16、後半の場面15）、`scripts/e2e-stripe-ordering.ts`（場面3〜5）、`scripts/e2e-admin-restore-browser.ts`
- **残る限界：** Stripe を確かめた後・書き込むまでの間に Stripe で新しい返金が作られ、その通知がまだ処理されていない場合は、一度だけ権利が戻ります（その後の通知で権利と注文は再び止まる）。Stripe との共通のロックが無いため、これ以上は防げません（§5）

---

## 2. Webhook と決済確定の処理の流れ

### 2.1 受け口（`src/app/api/webhooks/stripe/route.ts` → `src/lib/payments/stripe-webhook.ts`）

1. 生の本文と `Stripe-Signature` で署名を確認する（5分以内）。署名が不正なら 400（中身・署名は記録しない。件数だけを1時間ごとにまとめて決済監視に記録）
2. 通知の `livemode` が実行環境のモードと違えば 400（決済要確認に `mode_mismatch` を記録）
3. `webhookEvents/stripe_{イベントID}` で処理済みかを確かめる。処理済みなら 200（`duplicate: true`）で何もしない
4. 種類ごとに処理する（通知の中身は使わず、Stripe API から取り直す）。成功したら処理済みにして 200
5. 処理で例外が出たら、処理済みにせず 500（Stripe が再送する）。決済監視に種類ごとの異常を記録する
6. 決済の完了の通知で、**Stripe では支払い済み（金額・metadata・PaymentIntent・Charge を検証済み）なのに、この環境の注文・店舗の記録と照合できず確定しなかった**ときは、
   決済要確認（`paid_checkout_unconfirmable`・対象は Charge）と決済監視（`stripe_paid_not_confirmed`・対象は注文。決済監視の点検と同じ記録）に記録する。記録できなければ 500
   - 注文が無い（`unknown_checkout`）・店舗が無い（`store_not_found`）：記録が戻れば確定できる可能性があるので、**処理済みにせず 500**。
     記録が戻った後の Stripe の再送・Webhook の自動の復旧・運営の再処理で確定する（決済記録は PaymentIntent で1件に決まるので二重にならない）
   - 注文が別の決済と紐付いている・同じ注文が別の決済で確定済み・返金済みの注文・注文と金額や店舗が一致しない など：再送しても変わらないので、記録して 200（処理済み）。運営が確認し、必要なら返金する
   - 対象は、この環境で作った Session（metadata の環境を表す値が同じ）だけ。値が無い以前の Session は今までどおり（記録せず処理済み）
   - 記録するのは Stripe の Session・PaymentIntent・Charge の ID、注文・店舗の ID、金額、モード、理由の名前だけ（個人情報・秘密情報・通知の本文・署名は記録しない）

- 処理済みの記録は、作成から90日で毎日の定期処理が削除します（処理済みのものだけ）
- **実装済み・テスト済み**：`tests/stripe.test.ts`、`scripts/e2e-stripe.ts`、`scripts/e2e-stripe-ordering.ts`

扱う通知（16種類。Stripe の送信先にこれだけを登録する。[preview-verification.md §1.4](preview-verification.md)）：

| 通知 | 処理 |
| --- | --- |
| `checkout.session.completed`・`checkout.session.async_payment_succeeded` | 決済確定（§2.2） |
| `checkout.session.expired`・`checkout.session.async_payment_failed` | 注文を閉じる（`EXPIRED`・`FAILED`。未払いのときだけ） |
| `charge.refunded`・`charge.refund.updated`・`refund.created`・`refund.updated`・`refund.failed` | 返金の反映（`syncStripeRefunds`） |
| `charge.dispute.created`・`.updated`・`.closed`・`.funds_withdrawn`・`.funds_reinstated` | 異議申し立ての反映（`syncStripeDispute`） |
| `charge.updated`・`charge.succeeded` | 手数料が推定値のままの決済記録を、Stripe の確定値に更新（`refreshStripeFee`） |

### 2.2 決済確定（`confirmStripeCheckout`。Webhook・戻り先・状態の確認・決済画面への移動から呼ばれる）

1. Stripe API から Session・PaymentIntent・Charge を取り直し、注文・金額・店舗・占いの種類・支払い方法を照合する
2. **事前の読み取り：** その Charge の返金と異議申し立ての一覧を Stripe API から読み、検証する（`readStripeChargeAdjustments`）。取得の失敗・検証できない内容（返金・異議申し立てが多すぎる、別の Charge・通貨・金額・モードの食い違い、複数の異議申し立て）は例外で、**決済確定を進めない**（Webhook は 500 で再送される）
3. 1つのトランザクションで、決済記録・占い権利・注文を作成する。返金・敗訴があれば、権利は**最初から停止の状態**で作り（一瞬も `PAID` にしない）、注文は `REFUNDED` にする（§1.2）
4. **作成の後の再確認：** この呼び出しで作成したときだけ、もう一度 Stripe を読む。手順2から作成までの間に起きた返金・異議申し立てがあれば、反映の処理で取り直して反映する。再確認が失敗しても確定は取り消さない（サーバーのログと決済監視の `refund_sync_failed` に記録）

- 決済記録は ID が PaymentIntent で決まり、`tx.create` で作るので、Webhook・戻り先・状態の確認が同時に動いても1件だけです。後の処理は `duplicate`（注文が `REFUNDED` なら `refunded`）を返します
- **実装済み・テスト済み**：`src/lib/payments/stripe-checkout.ts`（`readStripeChargeAdjustments`）、`tests/stripe-confirm-adjustments.test.ts`、`scripts/e2e-stripe.ts`（後半の場面13）、`scripts/e2e-stripe-ordering.ts`（場面1・2・5）

### 2.3 返金・異議申し立ての反映（`syncStripeRefunds`・`syncStripeDispute`）

- Stripe API から最新の状態を取り直し、決済記録と照合（決済ID・モード・金額・通貨・店舗）してから反映します。食い違いは反映せず、決済要確認（`charge_mismatch` など）に記録します
- 状態のキー（`refundKey`・`disputeKey`）が同じなら書き込みません（再送・重複・同じ状態の別の通知）
- 結果が出た異議申し立て（勝訴・敗訴）を、対応中に戻しません（決済要確認に `dispute_state_regressed` を記録）
- 決済記録・占い権利・注文・精算の調整を、同じトランザクションで更新します
- **決済記録がまだ無いとき（決済確定より先に届いた通知）は反映せず、決済要確認に `transaction_not_found` を記録して 200 を返します（処理済みになる）。** その決済は、後の決済確定（§2.2）が Stripe の今の状態を読むので、最後は正しい状態になります。**ただし、この確認待ちは自動では解消しません**（§5）

### 2.4 通知の重複・順序の入れ替わり・同時実行

| 場面 | 結果 | 状態 |
| --- | --- | --- |
| 同じイベント ID の通知の重複・再送 | 処理済みなら何もしない（200 `duplicate`） | 実装済み・テスト済み |
| 同じ状態の別の通知（別のイベント ID） | 状態のキーが同じなら書き込まない | 実装済み・テスト済み |
| 支払い完了・返金・異議申し立ての通知の到着順序の入れ替わり | 6種類の状態 × すべての並び ＋ すべて同時（22通り）で、最後は Stripe の状態どおり | 実装済み・テスト済み（`scripts/e2e-stripe-ordering.ts` 場面1） |
| Webhook と戻り先と状態の確認が同時 | 決済記録・権利は1件 | 実装済み・テスト済み |
| 決済確定の途中の返金・異議申し立て | 作成の後の再確認で反映 | 実装済み・テスト済み（`scripts/e2e-stripe.ts` 後半の場面13、`scripts/e2e-stripe-ordering.ts` 場面2） |
| 運営の復旧と Webhook が同時 | 新しい返金・敗訴と同時なら戻さない。同じ状態の通知と同時なら成功1回 | 実装済み・テスト済み（`scripts/e2e-stripe-ordering.ts` 場面4） |

### 2.5 API の障害と再試行

| 失敗するところ | 動作 | 状態 |
| --- | --- | --- |
| 決済確定（Stripe の取得・検証・Firestore） | 処理済みにせず 500。同じイベントの再送で確定（記録は1件） | 実装済み・テスト済み |
| 返金・異議申し立ての反映 | 処理済みにせず 500。同じイベントの再送で1回だけ反映 | 実装済み・テスト済み |
| 運営の復旧 | Stripe を確認できなければ戻さない（`stripe_unavailable`）。回復の後に戻す | 実装済み・テスト済み |
| 作成の後の再確認 | 確定は取り消さず、決済監視に記録 | 実装済み・テスト済み（記録の部分は未検証） |
| Stripe の本番の再送の期間（最長3日）・Sandbox の再送の回数（数時間で3回） | Stripe の公式の資料の値。実際の再送は未検証 | 未検証（実環境） |
| Webhook の関数の時間切れ | 処理済みにならないので、処理権の期限（360秒）の後の再送で処理し直す。`maxDuration = 300`（Hobby・Fluid Compute 有効） | 実装済み・Vercel 上は未検証（[preview-verification.md §11](preview-verification.md)） |

---

## 3. 売上・手数料・店舗精算の仕様

### 3.1 売上の対象と手数料の対象

| | 売上の対象 | 手数料の対象 |
| --- | --- | --- |
| 判定 | `countable`：`paymentStatus` が `SUCCEEDED`、かつ本番の決済 | `feeCountable`：本番の決済（決済の状態に関係しない） |
| 集計のキー | `cYm`・`cDate`・`cStore`・`cStoreYm`（返金・敗訴で更新） | `feeYm`・`feeDate`・`feeStore`・`feeStoreYm`（作成時に1回だけ。返金・異議申し立てでは変えない） |
| 全額の返金・全額の敗訴 | 数えない | **数える**（Stripe は返金しても手数料を返さない） |
| 一部の返金・一部の額の敗訴 | 残りの額で数える | 数える |
| Sandbox（テスト決済）・判定不可 | 数えない | 数えない |

- 「本番の決済」は `livemode=true` の決済です（自動テスト環境の疑似決済は例外的に数える。`src/lib/payments/kind.ts`）
- 手数料は決済記録ごとに1回だけ数えます（同じ記録が売上と手数料の両方の検索に出ても、ID で重複を除く）
- **実装済み・テスト済み**：`src/lib/firestore/shared.ts`（`salesKeys`・`feeKeys`）、`src/lib/firestore/reports.ts`（`feeTotalsOf`）、`tests/fee-aggregation.test.ts`、`scripts/e2e-stripe-settlement.ts`（手数料の集計の場面8）、`scripts/e2e-stripe-ordering.ts`

### 3.2 Stripe の確定の手数料と推定の手数料

- Stripe の決済：Charge の `balance_transaction` の手数料（Stripe の確定値）を記録します。まだ取れなければ、固定の率（`PAYMENT_FEE_RATE_BPS`。既定 360 ＝ 3.6%）で計算した推定値を `feeEstimated: true` として記録し、`charge.updated`・`charge.succeeded` の通知で確定値に更新します
- 疑似決済・以前の決済代行（PAY.JP）の手数料は、常に固定の率の推定値です
- 運営の画面は、手数料の合計に「うち推定手数料 ¥x」を、推定値の行に「推定」の印を表示します（ダッシュボード・決済履歴・店舗の詳細）
- **実装済み・テスト済み**：`src/lib/services/reports.ts`（`feeEstimated`）、`scripts/e2e-stripe.ts`（場面6）
- **未実装：** 異議申し立てごとに Stripe が別に請求するチャージバックの手数料の記録・集計

### 3.3 以前の形の決済記録

- 手数料の集計のキー（`feeCountable` など）が無い記録（キーを追加する前に作られた記録）は、今までどおり**売上の対象のものだけ**手数料に数えます。データの移行はしていません
- そのため、キーの無い記録のうち返金済み・チャージバックのものの手数料は、今も集計に入りません
- **実装済み・テスト済み**：`tests/fee-aggregation.test.ts`、`scripts/e2e-stripe-settlement.ts`（手数料の集計の場面8で新旧の記録を混ぜて確認）、`scripts/e2e-admin-empty.ts`
- **未検証：** 本番の Firebase に以前の記録があるか（接続が禁止のため確認していない。§5）

### 3.4 店舗の取り分・精算額

- 店舗の取り分は全店舗一律30%（`STORE_SHARE_BPS = 3000`）。決済の時点の取り分を決済記録に保存し、書き換えません
- 精算（`src/lib/firestore/settlements.ts`）は売上の対象の決済だけを集計し、「今の時点で支払うべき取り分」を毎回状態から求めます（`entitledStoreShare`）：
  - 全額の返金・全額の敗訴：0円
  - 一部の返金：返金の後の額 × 30%（切り捨て）
  - 異議申し立ての対応中：申し立ての額の分だけ保留（`heldShare`）。勝訴で解除、敗訴で除外
- **手数料は店舗の取り分から差し引きません**（運営の負担）
- 精算を確定した後の返金・異議申し立ては、差額を `settlementAdjustments`（調整）に記録し、次に確定する精算で反映します（マイナスで振込額を超える分は繰越）
- Sandbox の決済は精算に含めません
- **実装済み・テスト済み**：`src/lib/payments/settlement-rules.ts`、`src/lib/firestore/settlement-adjustments.ts`、`tests/settlement-rules.test.ts`、`scripts/e2e-stripe-settlement.ts`、`scripts/e2e-stripe-settlement-safety.ts`
- **未検証（実環境）：** 本番の決済での精算・振込後の調整

---

## 4. 運営の操作の手順

どの操作も運営のアカウントだけです（店舗のアカウントは 404、ログインなしはログイン画面）。権限・入力・成功の判定はサーバーで行います。
操作が成功して対象が一覧から消えるときは、元の画面に移動し、上部に固定の文言の通知を表示します（決済ID・理由・個人情報は含めない。再読み込み・戻る操作では操作は再実行されない）。
関連するコード：`src/app/admin/actions.ts`、`src/lib/admin/transaction-notices.ts`、`src/lib/admin/list-notices.ts`。テスト：`tests/admin-restore-action.test.ts`、`scripts/e2e-admin-restore-browser.ts`。

### 4.1 返金の確認（運営画面 > 決済履歴 >「返金の確認が必要な決済」）

対象は、返金が一部だけ成功した決済と、返金がすべて失敗した決済です（`refundNeedsReview`）。

1. Stripe の Dashboard で、その決済の返金の状況を確かめる
2. お客さんに占いを提供する場合は §4.3（権利の復旧）。提供しない場合は「確認済みにする」
3. 完了すると、決済履歴の上部に「返金の確認を完了しました」と表示され、一覧から消える（監査ログ `stripe_test.refund_review_dismissed`）

### 4.2 異議申し立ての確認（運営画面 > 決済履歴 >「異議申し立て（チャージバック）の確認が必要な決済」）

1. 対応中の決済は精算を保留しています。Stripe の Dashboard で期限までに対応する
2. 対応中の間は「結果待ち」と表示され、確認を完了できません（サーバーでも完了しない）
3. 結果が出たら「確認済みにする」。上部に「異議申し立ての確認を完了しました」と表示され、一覧から消える（監査ログ `stripe.dispute_review_dismissed`）

### 4.3 占い権利の復旧と理由の記録（「返金の確認が必要な決済」の行）

1. 戻せる決済には理由の入力欄があります。戻せない決済には、戻せない理由が表示されます（§1.5）
2. 理由（必須・200文字まで）を入力し、「占い権利を戻す」→ 確認の画面で承認
3. 成功すると、決済履歴の上部に「占い権利を復旧しました（有効期限は復旧時から24時間）」と表示されます。権利は `PAID`、注文は `SUCCEEDED`、監査ログに理由・前後の状態・返金の状態と額が残ります
4. 理由にお客さんの個人情報を書かないでください（監査ログに残る）
5. 戻す前に、Stripe の Dashboard で新しい返金の操作をしていないことを確かめてください（§1.5 の残る限界）

### 4.4 決済要確認（運営画面 > 決済要確認）

Stripe の通知のうち、記録と照合できず反映していないもの（`charge_mismatch`・`dispute_amount_invalid`・`transaction_not_found`・`mode_mismatch`・`multiple_disputes`・`dispute_state_regressed`）と、以前に確定した精算の月の変化（`legacy_settlement_change`・`legacy_settlement_mismatch`）です（`src/lib/firestore/payment-reviews.ts`）。

1. Stripe の Dashboard と照らし合わせる
2. 「確認済みにする」。上部に「決済要確認を確認済みにしました」と表示されます（絞り込み `status` はそのまま。監査ログ `payment_review.resolved`）
3. 同じ内容がくり返し届いても未確認には戻りません。内容が変わったら未確認に戻ります

### 4.5 決済監視（運営画面 > 決済監視）

処理の失敗（Webhook・返金・異議申し立て・精算の確定・決済の API の 5xx・署名の不正）と、点検で見つかった食い違いです（`src/lib/firestore/payment-alerts.ts`、`src/lib/payments/payment-monitor.ts`）。

1. 「今すぐ点検（読み取りのみ）」で点検する：確定待ちのまま60分を過ぎた注文、Stripe で支払い済みなのに未確定の注文、占い権利の無い決済、確定済みの精算の金額。上限・時間切れがあれば「一部未確認」
2. 異常を確かめて「確認済みにする」。上部に「決済監視の異常を確認済みにしました」と表示されます（絞り込み `status`・`mode` はそのまま。監査ログ `payment_alert.resolved`）
3. 定期の点検（Cron）・異常の通知（メールなど）は**未実装**です

### 4.5.1 決済照合（運営画面 > 決済照合。F2 第1段階）

Stripe の決済（PaymentIntent）の一覧を起点に、この環境の支払い済みの決済が Firestore の注文・取引と一致しているかを照合します（`src/lib/payments/stripe-reconcile.ts`・`reconcile-rules.ts`、API は `src/app/api/admin/payment-reconcile/route.ts`）。決済監視は Firestore の注文を起点にするので、**注文そのものが消えた決済・Webhook が届かなかった決済は、こちらでだけ見つかります**。

- 読み取り専用：Stripe は一覧の取得（`GET /v1/payment_intents`。`created` で期間・新しい順・`starting_after` でページ送り・展開なし）と接続のアカウントの確認だけ。Firestore は ID で読むだけ。書き込みは実行ごとの監査ログ（`payment_reconcile.run`）1件だけ。自動の修正・返金・決済要確認への登録はしません
- 対象：livemode が接続のモードと同じで、metadata の `uranaiEnv` がこの環境の値の決済。値が無い・形が違う支払い済みの決済、本番の接続での別の環境の値の決済は「要確認」（正常とは扱わない）。テストの接続での別の環境の決済は対象外（同じ Sandbox を使う別の環境）
- 異常：`stripe_paid_no_checkout`（注文が無い）・`stripe_paid_no_transaction`（取引が無い）・`amount_or_mode_mismatch`（金額・通貨・モード・店舗・占いの種類・Charge の不一致）・`duplicate_or_bad_link`（同じ注文への2回目の支払い・取引や注文の紐付けの食い違い・metadata に注文の ID が無い）。同じ決済が F1 の決済要確認（`paid_checkout_unconfirmable`）に記録済みなら「記録済み」と表示
- 重複：同じ注文に、注文が紐付いていない（未確定の）支払い済みの決済が2件以上あれば、ページをまたいでも、支払いから60分以内でも、すべて重複（`duplicate_in_run`）。確定済みの1件目は重複にしません（2件目は「注文は別の決済と紐付いている」）。判定は照合した期間の中だけ。未確定の支払い済みの決済が1回の照合で1,000件を超えたら、超えた分は判定せず、画面に「重複が無いとは言えない」と表示します
- 処理待ち：支払いから60分以内で記録がまだ無いものは異常にしません。支払いが完了していない PaymentIntent（処理中など）は照合しません
- 未完了：Stripe・Firestore の取得の失敗、1回の実行の上限（約40秒・30ページ＝3,000件）で止まったら「未完了」。**すべてのページを読み終えるまで「異常なし」と表示しません**。「続きから照合する」で再開（開始から2時間まで）。再開用の値はサーバーが署名し、期間・モード・環境・アカウント・運営者を含むので、再開のときに変えられません
- 期間は日本時間の日付で最長31日。終わりは実行の開始の時刻まで
- 返金・異議申し立て・確定済みの精算の調整（第2段階a）：決済の一覧の後に、期間の中に作られた返金の一覧・異議申し立ての一覧（`created` で期間・ページ送り）を読みます。元の決済が期間の外でも、PaymentIntent を取り直して環境・モードを確かめ、取引を ID で読んで照合します。決済の一覧では `data.latest_charge` を展開し、返金・異議申し立てがある（または取引に記録がある）Charge だけ、Charge ごとの返金・異議申し立ての一覧を取り直します。同じ Charge は二重に数えません
  - 返金（`refund_mismatch`）：取引の返金の記録が、Webhook の反映（`syncStripeRefunds`）と同じ規則で今の Stripe の返金から求めた値（`refundKeyOf`）と一致するか。取引にだけ記録がある・決済の状態（返金済み）が違うのも異常。返金の作成から60分以内の食い違いは処理待ち。処理中を反映済みなら正常な一時状態、部分返金・返金の失敗は「要確認」（返金の確認の画面）
  - 異議申し立て（`dispute_mismatch`）：同じく `disputeKeyOf` と、敗訴（全額）ならチャージバックであること。結果が出た申し立てが Stripe で対応中に戻ったものは時間によらず異常。複数・内容の異常は「要確認」
  - 精算の調整（`settlement_adjustment_mismatch`）：確定済み（lockedAt あり）の精算に含めた取引で「今の取り分 = 支払った額（settledShare）＋調整の合計（adjustmentTotal）」か。あわせて調整の記録（`settlementAdjustments/{取引ID}_1〜n`）がすべてあり、取引・店舗・精算が一致し、合計が adjustmentTotal と一致し、n+1 番目が無いこと。**過去の精算に含めた取引が後から返金されても、調整が正しければ異常にしません**。以前の仕組みで確定した月は判定せず「要確認」。確定済みの月の、精算に含めていない取引は「精算への取り込み待ち（要確認）」
  - 返金・異議申し立ての状態の変化（処理中→成功・対応中→勝訴など）には Stripe の日時が無いため、変化の直後は反映の前に異常として出ることがあります（時間をおいて照合し直す）
  - 取得の失敗（返金・異議申し立ての一覧、Charge ごとの取り直し）は照合全体を「未完了」にします。1回の実行で確かめる Charge は60件まで（超えたら続きから）
- Firestore にだけある取引の照合（第2段階b）、定期実行（Cron）、決済要確認への自動の登録は**未実装**です
- 異常が見つかったら：表示された PaymentIntent・Charge の ID で Stripe の Dashboard を、注文・取引の ID で Firestore（決済履歴）を確かめ、運営が判断します（復旧・返金は既存の手順）

### 4.6 エラー・確認待ちが残ったとき

| 状況 | 対応 |
| --- | --- |
| 決済要確認に `transaction_not_found` が残る | 決済確定より先に届いた返金・異議申し立ての通知です。決済履歴でその決済の状態が Stripe と一致していることを確かめてから「確認済みにする」（自動では解消しない） |
| 決済要確認に `paid_checkout_unconfirmable` | Stripe では支払い済みだが、注文・店舗の記録と照合できず確定していません（理由は「一致しない項目」に、`unknown_checkout` などの名前で表示）。`unknown_checkout`・`store_not_found` は、記録が戻れば Stripe の再送・Webhook の復旧で確定します。それ以外は、Stripe の Dashboard で決済を確かめ、必要なら返金してから「確認済みにする」。**復旧して確定した後も、この決済要確認と決済監視の通知（`stripe_paid_not_confirmed`・`checkout_confirm_failed`）は未確認のまま残ります（自動では解消しない）。決済履歴でその決済の決済記録があり、Stripe と一致していることを確かめてから、手動で「確認済みにする」** |
| 決済監視に「Stripe で支払い済みなのに未確定」 | 決済確定が失敗し続けています。Stripe の障害なら回復後の再送を待つ。Stripe の Dashboard から通知を再送する場合は、**本物の Stripe での操作になるので運営の判断で行う** |
| 決済監視に `refund_sync_failed`（決済記録の ID） | 決済確定の後の再確認が失敗しました。その決済の返金・異議申し立ての状態を Stripe と照らし合わせる（その後の通知でも反映される） |
| 復旧の操作が `state_changed` | 確認の途中で状態が変わりました。画面を開き直して、もう一度確認する |
| 復旧の操作が `stripe_unavailable` | Stripe を確認できませんでした。時間をおいてもう一度 |
| 復旧の操作が `stripe_unverified`・`payment_mismatch` | 記録と Stripe が食い違っています。戻さずに、決済要確認・Stripe の Dashboard を確かめる |

---

## 5. 未解決の課題と本番移行の前の確認

### 5.1 未解決の課題

| # | 課題 | 状態 | 影響 |
| --- | --- | --- | --- |
| 1 | `transaction_not_found` の確認待ちの自動の解消 | 未実装 | 決済確定より先に届いた通知の確認待ちが残る（記録の状態は正しい） |
| 2 | 返金・異議申し立ての Webhook の先着対策（決済記録が無ければ、決済確定を試みてから反映・一時的な保留を 500 にする） | 未実装（対策A） | 決済確定の通知が届かないと、返金・異議申し立てが記録されない（決済監視の「未確定」で検知はできる） |
| 3 | 定期的な照合の処理（取りこぼした通知の回復） | 一部実装（手順3-9：**記録のある**未処理の通知の自動・手動の復旧。[preview-verification.md §12](preview-verification.md)） | 一度も受信していない通知（記録が無い）・Stripe の保存期間を過ぎた通知は自動では回復しない（後者は FAILED_PERMANENT で要確認） |
| 4 | Stripe を確認した直後の状態の変化による競合（運営の復旧） | 残る限界 | 一度だけ権利が戻る可能性（その後の通知で再び止まる） |
| 5 | Webhook の関数の時間切れと再送（`maxDuration = 300`・処理権の期限360秒） | Vercel 上は未検証 | 300秒を超える処理は再送に頼る |
| 6 | 追加のチャージバックの手数料 | 未実装 | 運営の手数料の合計が少なく表示される |
| 7 | 本番の Firebase の以前の決済記録 | 未確認 | キーの無い返金済みの記録の手数料は集計外 |
| 8 | Preview の古い記録（修正より前に作られ、権利は止まっているのに注文が `SUCCEEDED` のもの） | 未対応 | Preview の表示だけ（自動では直らない） |
| 9 | PostgreSQL の経路の手数料の集計 | 未対応 | 今も売上の対象だけ（Stripe は Firestore だけなので実害なし） |
| 10 | Playwright の CI の環境 | 未対応 | ブラウザの E2E は、この開発環境に事前に入っている Playwright・Chromium（`NODE_PATH`）を使う。プロジェクトの依存関係ではない |
| 11 | 監査ログのイベント名（`stripe_test.entitlement_restored`・`stripe_test.refund_review_dismissed`） | 未対応 | 本番の決済で `stripe_test` の名前になる |
| 12 | 本物の Stripe の Sandbox での検証（決済確定の事前の読み取り・再確認・`REFUNDED`・復旧・手数料） | 未検証（実環境） | 模擬の Stripe との違いがあれば見落とす |
| 13 | ほかの運営画面の、一覧から行が消える操作の成功のメッセージ | 未確認 | 表示だけ |
| 14 | 環境の目印（metadata に Firebase のプロジェクト）で、別の環境の Sandbox の決済を無視する | 未実装 | Sandbox を複数の環境で共用すると、決済要確認に記録が増える |

### 5.2 本番移行の前の確認

**必須（本番の決済を有効にする前に）：**
- [ ] 本番の Stripe 決済（Live）の実装と、本番のキー・Webhook の送信先・必要な16種類の通知の登録（現在は未実装・無効）
- [ ] 課題2・3（先着対策・定期的な照合）：Webhook の取りこぼしと先着の通知から回復できること
- [x] 課題5：Vercel のプランの関数の時間の上限を確かめ、`maxDuration` を決める（Webhook は300秒。戻り先・決済画面の作成・点検は未設定）
- [ ] 課題7：本番の Firebase の既存の決済記録を、読み取り専用で確かめる（キーの無い記録の件数）
- [ ] 課題11：監査ログのイベント名を本番の運用に合わせる
- [ ] 課題12：本物の Stripe の Sandbox で、返金（処理中・成功・一部・失敗）・異議申し立て（対応中・勝訴・敗訴）・復旧を確かめる（[preview-verification.md §4](preview-verification.md)）
- [ ] 本番の Firestore のインデックスと rules の適用（[preview-verification.md §1.3](preview-verification.md)）
- [ ] 法的な表示（特定商取引法など）の確認

**後回しにできる：**
- [ ] 課題1：`transaction_not_found` の自動の解消（運営が手で確認済みにできる）
- [ ] 課題4：運用の注意（§4.3 の5）で補う
- [ ] 課題6：チャージバックの手数料の記録
- [ ] 課題8：Preview の古い記録の整理
- [ ] 課題9：PostgreSQL の経路の手数料
- [ ] 課題10：ブラウザの E2E の CI への組み込み
- [ ] 課題13：ほかの運営画面の成功のメッセージ
- [ ] 課題14：環境の目印
- [ ] 定期の点検（Cron）・異常の通知

### 5.3 第3段階以降の作業の優先順位と依存関係

以下の作業は**すべて未実装**です（作業A〜Gは名前を付けて区別するためのもので、設計は決まっていません。設計の前提として書いたものは「予定」と明記します）。

| 順 | 作業（課題の番号） | 先に終えておく作業 | 理由 |
| --- | --- | --- | --- |
| 1 | **作業A：本物の Stripe の Sandbox での確認**（課題12） | なし | 実装済みの動作の前提（Stripe API の応答・通知の中身・届く順番）を実環境で確かめる。結果によって作業C〜Eの設計が変わる |
| 2 | **作業B：関数の時間の上限と `maxDuration` の決定**（課題5） | なし（作業Aと並行できる） | 作業C・Dは Stripe API の呼び出しが増えるため、先に時間の上限を決める（[preview-verification.md §11](preview-verification.md)） |
| 3 | **作業C：Webhook の先着問題への対策**（課題2・対策A） | 作業A・作業B | 返金・異議申し立ての通知が決済確定より先に届いたとき、今は反映せず `transaction_not_found` を記録して終わる。決済記録が無ければ決済確定を試みてから反映し、確定できない一時的な状態なら 500 で再送を待つ（予定） |
| 4 | **作業D：環境の目印**（課題14） | 作業C | 作業Cで決済確定を試みるとき、別の環境（別の Firebase のプロジェクト）の Sandbox の決済を確定しないために、metadata の目印で区別する（予定） |
| 5 | **作業E：定期的な照合の処理**（課題3・対策C） | 作業B・作業C（・作業D） | Webhook の取りこぼし・再送の期限切れからの最後の回復。作業Cの「決済確定を試みてから反映する」処理を照合でも使う予定。Vercel の Cron は Production でだけ動き、Hobby プランは1日1回までのため、実行の間隔はプランで決まる |
| 6 | **作業F：`transaction_not_found` の確認待ちの自動の解消**（課題1） | 作業C・作業E | 作業Cで**新しく発生する**ことは大部分なくなるが、**既にある**確認待ちは残る。照合（作業E）で決済記録と Stripe の状態が一致すると確かめたものだけを解消する（予定）。一致しないものは運営の確認のまま残す |
| 7 | **作業G：本番の Firebase の既存の記録の確認・監査ログの名前**（課題7・課題11） | 本番の決済（Live）の実装 | 本番の決済を有効にする直前に行う。本番の Firebase は読み取りだけ |
| 8 | 表示・集計・テストの環境の改善（課題6・8・9・10・13） | なし | 本番の決済の可否には影響しない |

作業Cが終わるまでは、運営が §4.6 の手順で `transaction_not_found` を確認します。作業Eが終わるまでは、取りこぼしは決済監視の「未確定」で見つけて運営が対応します。

#### 本物の Stripe の Sandbox で今すぐ確かめられること（作業A）

実装済みの動作だけです。手順は [preview-verification.md §4](preview-verification.md) です。**いずれも未確認**です（模擬の Stripe・Emulator でだけテスト済み）。

- 決済：成功・3Dセキュア・拒否・キャンセル・期限切れ・PayPay の確定待ち（使える場合）。Webhook と戻り先の両方が来ても決済記録が1件
- 決済確定の前の返金・異議申し立ての読み取りが、本物の API の応答で失敗しないこと（返金・異議申し立てが無い通常の決済で確定できる）
- 返金：処理中・成功（全額）・一部・失敗。権利の停止・注文の `REFUNDED`・お客さんの画面の表示・「返金の確認が必要な決済」への表示
- 異議申し立て：対応中（精算の保留・権利は止めない）・勝訴・敗訴（`CHARGEBACK`・注文の `REFUNDED`）
- 運営の復旧：理由の入力・Stripe の再確認・`state_changed` などの拒否・成功の通知・有効期限（復旧時から24時間）
- 手数料：`charge.updated` などで Stripe の確定の手数料に更新されること。確定前は推定値として表示されること
- 決済監視の「今すぐ点検」（Preview では定期の点検は無い）

次は Sandbox でも**意図して再現しにくい**ため、確かめられるかどうかも未確認です：返金・異議申し立ての通知が決済確定より先に届く場面（`transaction_not_found`）、決済確定と返金の同時の発生、運営の復旧と Webhook の同時の発生。これらは模擬の Stripe の E2E（`scripts/e2e-stripe-ordering.ts`）で確かめています。

#### 今後の実装の後に確かめ直すこと

| 実装する作業 | 確かめ直すこと |
| --- | --- |
| 作業B（`maxDuration`） | Webhook・決済確定・点検が時間の上限の中で終わること。時間切れのときに再送で回復すること |
| 作業C（先着対策） | 先着の返金・異議申し立てが、決済確定の後に正しく反映されること。`transaction_not_found` が新しく記録されないこと。一時的な状態の 500 と再送で二重に記録しないこと。通知の順序の E2E（`scripts/e2e-stripe-ordering.ts` 場面1〜3）の期待値の見直し |
| 作業D（環境の目印） | 別の環境の Sandbox の決済を確定・反映しないこと。目印の無い以前の決済の扱い |
| 作業E（定期的な照合） | 取りこぼした通知の決済・返金・異議申し立てが回復すること。Webhook と照合が同時に動いても1回だけ反映すること。Cron の実行（Production だけ）と時間・件数の上限 |
| 作業F（自動の解消） | Stripe と一致する確認待ちだけが解消され、一致しないものは残ること。監査ログ |
| 本番の決済（Live）の実装 | この文書の §1〜§4 のすべてを本番のモードで確かめ直す（本番の決済でしか確かめられない精算・振込後の調整を含む。[preview-verification.md §10](preview-verification.md)） |
| 作業G（監査ログの名前） | 監査ログの画面・検索で、以前の名前と新しい名前の両方を読めること |

---

## 6. テストの実行

| コマンド | 内容 |
| --- | --- |
| `npm test` | 単体テスト（規則・照合・集計・画面のサーバーの処理） |
| `npm run e2e:stripe` | 運営の Sandbox テスト（HTTP の経路。起動中のアプリが必要） |
| `npm run e2e:stripe-public` | 一般のお客さんの流れ |
| `npm run e2e:stripe-live` | 本番モードの照合（模擬） |
| `npm run e2e:stripe-settlement`・`e2e:stripe-settlement-safety` | 返金・異議申し立て・精算の調整・手数料 |
| `npm run e2e:payment-monitor` | 決済監視 |
| `npm run e2e:stripe-ordering` | 通知の順序・同時実行・再送・復旧の競合・API の障害からの回復（各操作の後に不変条件を確認） |
| `npm run e2e:admin-restore-browser` | 運営画面のブラウザの操作（Chromium。Playwright が入った環境と、起動中のアプリが必要） |
| `npx tsx --conditions=react-server scripts/e2e-payment-reconcile.ts` | Stripe 起点の決済照合（ページ送り・取得の失敗・再開・読み取り専用） |
| `npx tsx --conditions=react-server scripts/e2e-payment-reconcile-adjustments.ts` | 決済照合の返金・異議申し立て・精算の調整（期間より前の決済・取得の失敗・再開・読み取り専用） |
| `npx tsx --conditions=react-server scripts/e2e-payment-reconcile-browser.ts` | 決済照合の運営画面（Chromium。起動中のアプリが必要） |

どの E2E も、Firestore Emulator の `demo-` プロジェクトと localhost の模擬 Stripe だけを使います（本物の Stripe・本番の Firebase には接続しない）。
起動の手順は各スクリプトの先頭の説明を参照してください。
