import { NextResponse } from "next/server";
import { AggregateField, type Query } from "firebase-admin/firestore";
import { getSessionUser } from "@/lib/auth/session";
import { isFirestore } from "@/lib/data-provider";
import { C, fsdb } from "@/lib/firestore/admin";
import { jstYearMonth } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * 【一時的な診断用】運営管理画面の売上集計が本番 Firestore で動くかを、1つずつ確かめる。
 *   GET /api/admin/diagnostics/aggregation
 *
 * - 運営アカウントでログインしているときだけ実行できる（未ログイン・店舗アカウントは 404）
 * - Firestore の読み取りだけを行う（作成・更新・削除は一切しない。回数制限もメモリ上で管理し、DB に書かない）
 * - 返すのは「処理名・成功/失敗・エラーコード」だけ。売上金額・件数・個人情報・エラー本文は返さない
 * - 連続実行を防ぐため、同じアカウントは30秒に1回まで（サーバー全体でも1時間20回まで）
 * - 恒久的な API にしないため、EXPIRES_AT を過ぎると自動で 404 になる（原因の確定後にこのファイルごと削除する）
 */
const EXPIRES_AT = new Date("2026-11-15T00:00:00+09:00");
const PER_USER_INTERVAL_MS = 30_000;
const GLOBAL_LIMIT_PER_HOUR = 20;

const lastRunByUser = new Map<string, number>();
let globalRuns: number[] = [];

function allowRun(userId: string, now: number): boolean {
  const last = lastRunByUser.get(userId);
  if (last !== undefined && now - last < PER_USER_INTERVAL_MS) return false;
  globalRuns = globalRuns.filter((t) => now - t < 3_600_000);
  if (globalRuns.length >= GLOBAL_LIMIT_PER_HOUR) return false;
  lastRunByUser.set(userId, now);
  globalRuns.push(now);
  return true;
}

type Step = { step: string; ok: boolean; code?: string };

async function run(steps: Step[], step: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    steps.push({ step, ok: true });
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? "unknown");
    steps.push({ step, ok: false, code });
    // Vercel Runtime Logs で探せるよう、処理名とエラーコードだけを記録する（エラー本文・値は出さない）
    console.error(`[diagnostics:aggregation] step="${step}" failed code=${code}`);
  }
}

const notFound = () => new NextResponse("not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  const now = Date.now();
  if (now >= EXPIRES_AT.getTime()) return notFound();
  const user = await getSessionUser();
  if (!user || user.role !== "OPERATOR") return notFound();
  if (!allowRun(user.id, now)) {
    return NextResponse.json({ ok: false, reason: "rate_limited", retryAfterSec: 30 }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  if (!isFirestore()) return NextResponse.json({ ok: false, reason: "not_firestore" }, { headers: { "Cache-Control": "no-store" } });

  const tx = () => fsdb().collection(C.transactions);
  const month = (): Query => tx().where("cYm", "==", jstYearMonth());
  const all = (): Query => tx().where("countable", "==", true);
  const steps: Step[] = [];

  // 1) 通常の読み取り（/admin/settlements と同じ方式。これが成功すれば検索条件と読み取り権限は問題ない）
  await run(steps, "read_month", () => month().get());
  await run(steps, "read_month_select_amount_fields", () => month().select("amount", "storeShare", "operatorShare", "paymentFee").get());
  // 2) 集計クエリを1種類ずつ
  await run(steps, "aggregate_month_count", () => month().count().get());
  await run(steps, "aggregate_month_sum_amount", () => month().aggregate({ v: AggregateField.sum("amount") }).get());
  await run(steps, "aggregate_month_sum_storeShare", () => month().aggregate({ v: AggregateField.sum("storeShare") }).get());
  await run(steps, "aggregate_month_sum_operatorShare", () => month().aggregate({ v: AggregateField.sum("operatorShare") }).get());
  await run(steps, "aggregate_month_sum_paymentFee", () => month().aggregate({ v: AggregateField.sum("paymentFee") }).get());
  // 3) 管理画面が実際に使っている形（count と sum×4 を1回で）
  await run(steps, "aggregate_month_count_and_4_sums_as_admin", () =>
    month()
      .aggregate({
        count: AggregateField.count(),
        gross: AggregateField.sum("amount"),
        storeShare: AggregateField.sum("storeShare"),
        operatorShare: AggregateField.sum("operatorShare"),
        fee: AggregateField.sum("paymentFee"),
      })
      .get(),
  );
  // 4) 全期間（/admin/stores の「全期間」）
  await run(steps, "aggregate_all_time_count", () => all().count().get());

  return NextResponse.json({ ok: steps.every((s) => s.ok), steps }, { headers: { "Cache-Control": "no-store" } });
}
