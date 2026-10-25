"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";

type Phase = "checking" | "slow" | "failed" | "expired";

const INTERVAL_MS = [2_000, 2_000, 3_000, 3_000, 5_000];
const SLOW_AFTER_MS = 60_000;
const STOP_AFTER_MS = 10 * 60_000;

/** public-shell の Notice と同じ見た目（public-shell はサーバー専用の処理を読み込むので、ここでは使えない） */
function Notice({ title, children, action }: { title: string; children: React.ReactNode; action: React.ReactNode }) {
  return (
    <div role="status" className="glass mt-8 rounded-3xl p-7 text-center fade-up">
      <h1 className="font-serif text-xl font-bold text-gold-200">{title}</h1>
      <div className="mt-3 text-sm leading-relaxed text-ink-muted">{children}</div>
      <div className="mt-6">{action}</div>
    </div>
  );
}

/**
 * Stripe 側で支払いの確定を待つ間の表示（PayPay など、確定が遅れる支払い）。
 * /api/checkout/status をくり返し確認し、確定したら占いの入力へ進む。権利の付与はサーバーが Stripe API で確認してから行う。
 */
export function StripeReturnStatus() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let n = 0;
    async function tick() {
      try {
        const res = await fetch("/api/checkout/status", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { status?: string } | null;
        if (stopped) return;
        if (json?.status === "succeeded") {
          router.replace("/fortune/input");
          return;
        }
        if (json?.status === "failed") return setPhase("failed");
        if (json?.status === "expired") return setPhase("expired");
      } catch {
        // 通信の失敗は、次の確認で取り直す
      }
      if (stopped) return;
      const elapsed = Date.now() - started;
      if (elapsed > SLOW_AFTER_MS) setPhase("slow");
      if (elapsed > STOP_AFTER_MS) return;
      timer = setTimeout(tick, INTERVAL_MS[Math.min(n++, INTERVAL_MS.length - 1)]);
    }
    timer = setTimeout(tick, INTERVAL_MS[0]);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  if (phase === "failed" || phase === "expired") {
    return (
      <Notice title="お支払いが完了しませんでした" action={<Link href="/fortune" className="btn-gold inline-block rounded-2xl px-6 py-3 font-bold">占いを選び直す</Link>}>
        {phase === "failed" ? "お支払いを確認できませんでした（請求は発生していません）。" : "お支払いの有効期限が切れました。"}お手数ですが、占いの選択からやり直してください。
      </Notice>
    );
  }
  return (
    <Notice title="お支払いを確認しています" action={<Link href="/payment" className="btn-ghost inline-block rounded-2xl px-6 py-3 font-bold">お支払い画面に戻る</Link>}>
      <span className="inline-flex items-center gap-2">
        <Spinner /> Stripe での支払いの確定を待っています。
      </span>
      <br />
      {phase === "slow"
        ? "確認に時間がかかっています。このままお待ちいただくか、しばらくしてから「お支払い画面に戻る」を押してください。"
        : "PayPay などでは確定まで少し時間がかかることがあります。二重にお支払いいただく必要はありません。"}
    </Notice>
  );
}
