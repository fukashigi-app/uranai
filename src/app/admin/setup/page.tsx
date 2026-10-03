import { Logo } from "@/components/ui/logo";
import { SetupForm, SetupDone } from "@/components/console/setup-form";
import { hasDatabase } from "@/lib/data-provider";
import { isInitialSetupDone, setupTokenRequired } from "@/lib/services/setup";

export const metadata = { title: "運営アカウントの初期設定", robots: { index: false } };
export const dynamic = "force-dynamic";

/** 最初の運営アカウント作成画面。運営アカウントが既にあれば「完了しています」と表示するだけ */
export default async function AdminSetupPage() {
  let state: "form" | "done" | "nodb" | "error" = "form";
  if (!hasDatabase()) state = "nodb";
  else {
    try {
      if (await isInitialSetupDone()) state = "done";
    } catch (e) {
      console.error("[admin/setup] status check failed", (e as { code?: unknown })?.code ?? (e as Error)?.name ?? "error");
      state = "error";
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="glass w-full max-w-sm rounded-3xl p-7 fade-up">
        <Logo sub="ADMIN" />
        {state === "done" ? (
          <SetupDone title="初期設定は完了しています" body="運営アカウントは既に作成されています。ログイン画面からログインしてください。" />
        ) : state === "nodb" ? (
          <Notice title="データベースが未設定です" body="Vercel の環境変数（Firebase の設定）を登録してから、もう一度このページを開いてください。" />
        ) : state === "error" ? (
          <Notice title="現在この画面を利用できません" body="データベースに接続できませんでした。時間をおいて再度お試しください。" />
        ) : (
          <SetupForm tokenRequired={setupTokenRequired()} />
        )}
      </div>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1 className="mt-6 font-serif text-xl font-bold">{title}</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">{body}</p>
    </>
  );
}
