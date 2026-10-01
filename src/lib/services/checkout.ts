import "server-only";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkouts, stores, type FortuneTypeValue } from "@/lib/db/schema";
import { CHECKOUT_TTL_MS, CURRENCY, PRICE_JPY } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { activeProvider } from "@/lib/payments";
import { confirmCharge, markChargeFailed } from "@/lib/payments/confirm";
import { isProviderId } from "@/lib/payments";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { randomToken, sha256Hex } from "@/lib/security/crypto";

export class CheckoutError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly httpStatus = 400,
  ) {
    super(code);
  }
}

export async function findActiveStoreByCode(storeCode: string) {
  const [store] = await db()
    .select({ id: stores.id, name: stores.name, status: stores.status, storeCode: stores.storeCode })
    .from(stores)
    .where(eq(stores.storeCode, storeCode))
    .limit(1);
  return store ?? null;
}

/**
 * 決済セッション（注文）を作成する。
 * 店舗はクライアントが送る storeId ではなく、QR由来の storeCode を DB で再照会して決定する。
 * 金額はサーバーの固定価格のみを使う。
 */
export async function createCheckout(storeCode: string | null, fortuneType: FortuneTypeValue) {
  if (!storeCode) {
    throw new CheckoutError("no_store", "店舗のQRコードを読み込んでからご利用ください。");
  }
  const store = await findActiveStoreByCode(storeCode);
  if (!store) throw new CheckoutError("store_not_found", "店舗情報が見つかりません。お店のQRコードをもう一度読み込んでください。", 404);
  if (store.status !== "ACTIVE") {
    throw new CheckoutError("store_suspended", "こちらの店舗では現在ご利用いただけません。", 403);
  }
  const provider = activeProvider();
  const token = randomToken(32);
  const [row] = await db()
    .insert(checkouts)
    .values({
      storeId: store.id,
      fortuneType,
      amount: PRICE_JPY,
      provider: provider.id,
      accessTokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
    })
    .returning({ id: checkouts.id });
  return { checkoutId: row.id, accessToken: token };
}

export async function getCheckoutByToken(token: string | null) {
  if (!token) return null;
  const [row] = await db()
    .select({ checkout: checkouts, storeName: stores.name, storeStatus: stores.status })
    .from(checkouts)
    .innerJoin(stores, eq(stores.id, checkouts.storeId))
    .where(eq(checkouts.accessTokenHash, sha256Hex(token)))
    .limit(1);
  return row ?? null;
}

export type PayResult =
  | { status: "processing" }
  | { status: "succeeded" }
  | { status: "failed"; message: string };

/**
 * カードトークンで課金する。売上計上は行わない（Webhook/照合で確定）。
 */
export async function payCheckout(token: string | null, cardToken: string): Promise<PayResult> {
  const found = await getCheckoutByToken(token);
  if (!found) throw new CheckoutError("not_found", "お支払い情報が見つかりません。お店のQRコードから再度お試しください。", 404);
  const { checkout } = found;
  if (checkout.status === "SUCCEEDED") return { status: "succeeded" };
  if (found.storeStatus !== "ACTIVE") {
    throw new CheckoutError("store_suspended", "こちらの店舗では現在ご利用いただけません。", 403);
  }

  // CREATED/FAILED → PROCESSING を原子的に遷移（連打・同時リクエストによる二重課金防止）
  const [locked] = await db()
    .update(checkouts)
    .set({
      status: "PROCESSING",
      attemptCount: sql`${checkouts.attemptCount} + 1`,
      processingStartedAt: new Date(),
      failureCode: null,
    })
    .where(
      and(
        eq(checkouts.id, checkout.id),
        inArray(checkouts.status, ["CREATED", "FAILED"]),
        gt(checkouts.expiresAt, new Date()),
        sql`${checkouts.attemptCount} < 5`,
      ),
    )
    .returning({ attemptCount: checkouts.attemptCount });

  if (!locked) {
    // 同時リクエストに先を越された場合など。最新状態を読み直して判断する
    const [current] = await db().select({ status: checkouts.status }).from(checkouts).where(eq(checkouts.id, checkout.id));
    if (current?.status === "PROCESSING") return { status: "processing" };
    if (current?.status === "SUCCEEDED") return { status: "succeeded" };
    if (checkout.expiresAt <= new Date()) {
      throw new CheckoutError("expired", "お支払いの有効期限が切れました。お手数ですが占いの選択からやり直してください。", 410);
    }
    throw new CheckoutError("too_many_attempts", "お支払いの試行回数が上限に達しました。占いの選択からやり直してください。", 429);
  }

  const provider = activeProvider();
  if (provider.id !== checkout.provider) {
    throw new CheckoutError("provider_changed", "決済方法が変更されました。占いの選択からやり直してください。", 409);
  }
  const input = {
    amount: checkout.amount, // = PRICE_JPY（作成時にサーバーで設定）
    currency: CURRENCY,
    cardToken,
    description: `${siteConfig.name} ${FORTUNE_CATALOG[checkout.fortuneType].label}`,
    metadata: { checkoutId: checkout.id, storeId: checkout.storeId, fortuneType: checkout.fortuneType },
    idempotencyKey: `${checkout.id}-${locked.attemptCount}`,
  };
  let result = await provider.createCharge(input);
  if (!result.ok && result.ambiguous) {
    // 冪等キーが同じなので再送しても二重課金にならない
    result = await provider.createCharge(input);
  }

  if (!result.ok && result.ambiguous) {
    // 課金されたか不明。FAILED にすると別の冪等キーで再課金できてしまうため PROCESSING のまま保留し、
    // Webhook（metadata.checkoutId で照合）を待つ。届かなければ一定時間後に失敗扱いにする
    console.warn("[checkout] ambiguous charge result; keeping PROCESSING", { checkoutId: checkout.id, code: result.code });
    await db()
      .update(checkouts)
      .set({ failureCode: result.code.slice(0, 100) })
      .where(and(eq(checkouts.id, checkout.id), eq(checkouts.status, "PROCESSING")));
    return { status: "processing" };
  }

  if (!result.ok) {
    await db()
      .update(checkouts)
      .set({ status: "FAILED", failureCode: result.code.slice(0, 100) })
      .where(and(eq(checkouts.id, checkout.id), eq(checkouts.status, "PROCESSING")));
    return { status: "failed", message: result.userMessage };
  }

  await db()
    .update(checkouts)
    .set({ providerPaymentId: result.charge.id })
    .where(and(eq(checkouts.id, checkout.id), sql`${checkouts.providerPaymentId} IS NULL`));
  return { status: "processing" };
}

/** Webhook が届くまでの待ち時間。これを過ぎたら API で直接照合する */
const RECONCILE_AFTER_MS = 5_000;
/** Charge ID が分からないまま処理中になっている決済を失敗扱いにするまでの時間 */
export const STALE_UNKNOWN_CHARGE_MS = 15 * 60 * 1000;

export type CheckoutStatus = "created" | "processing" | "succeeded" | "failed" | "expired";

/**
 * 決済状態を返す。Webhook 遅延時は決済代行APIから Charge を取得して照合する
 * （クライアントの申告は使わない。confirmCharge は冪等）。
 */
export async function getCheckoutStatus(token: string | null): Promise<{ status: CheckoutStatus; failureCode?: string | null }> {
  const found = await getCheckoutByToken(token);
  if (!found) return { status: "expired" };
  const { checkout } = found;
  switch (checkout.status) {
    case "SUCCEEDED":
      return { status: "succeeded" };
    case "FAILED":
      return { status: "failed", failureCode: checkout.failureCode };
    case "EXPIRED":
      return { status: "expired" };
    case "CREATED":
      return { status: checkout.expiresAt > new Date() ? "created" : "expired" };
    case "PROCESSING": {
      const started = checkout.processingStartedAt?.getTime() ?? 0;
      if (!checkout.providerPaymentId && Date.now() - started > STALE_UNKNOWN_CHARGE_MS) {
        // 結果不明のまま Webhook も来なかった = 課金されていないと判断し、再試行を許可
        const failed = await db()
          .update(checkouts)
          .set({ status: "FAILED", failureCode: "stale_processing" })
          .where(and(eq(checkouts.id, checkout.id), eq(checkouts.status, "PROCESSING"), sql`${checkouts.providerPaymentId} IS NULL`))
          .returning({ id: checkouts.id });
        if (failed.length) return { status: "failed", failureCode: "stale_processing" };
      }
      if (checkout.providerPaymentId && isProviderId(checkout.provider) && Date.now() - started > RECONCILE_AFTER_MS) {
        try {
          const outcome = await confirmCharge(checkout.provider, checkout.providerPaymentId);
          if (outcome.status === "confirmed" || outcome.status === "duplicate") return { status: "succeeded" };
          if (outcome.status === "not_paid" && (await markChargeFailed(checkout.provider, checkout.providerPaymentId))) {
            return { status: "failed", failureCode: "charge_failed" };
          }
        } catch (e) {
          console.error("[checkout] reconcile failed", { checkoutId: checkout.id, error: (e as Error).message });
        }
      }
      return { status: "processing" };
    }
  }
}
