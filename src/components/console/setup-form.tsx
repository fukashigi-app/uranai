"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { setupAdminAction, type SetupState } from "@/app/admin/setup/actions";

export function SetupDone({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1 className="mt-6 font-serif text-xl font-bold">{title}</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">{body}</p>
      <Link href="/admin/login" className="btn-gold mt-6 flex h-12 w-full items-center justify-center rounded-xl font-bold">
        運営ログインへ
      </Link>
    </>
  );
}

function Field({ label, name, type, autoComplete, error, hint, required = true }: { label: string; name: string; type: string; autoComplete: string; error?: string; hint?: string; required?: boolean }) {
  return (
    <label className="mt-4 block">
      <span className="mb-1.5 block text-[12px] text-ink-muted">{label}</span>
      <input name={name} type={type} required={required} autoComplete={autoComplete} className="field" maxLength={type === "password" ? 200 : 254} aria-invalid={error ? true : undefined} />
      {hint ? <span className="mt-1 block text-[11px] text-ink-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-[12px] text-danger">{error}</span> : null}
    </label>
  );
}

/** 最初の運営アカウント作成フォーム（送信中は二重送信不可） */
export function SetupForm({ tokenRequired }: { tokenRequired: boolean }) {
  const [state, formAction, pending] = useActionState<SetupState, FormData>(setupAdminAction, null);
  if (state?.status === "created") {
    return <SetupDone title="運営アカウントを作成しました" body="この初期設定画面は無効になりました。作成したメールアドレスとパスワードでログインしてください。" />;
  }
  if (state?.status === "done") {
    return <SetupDone title="初期設定は完了しています" body="運営アカウントは既に作成されています。ログイン画面からログインしてください。" />;
  }
  const err = state?.errors ?? {};
  return (
    <form action={formAction}>
      <h1 className="mt-6 font-serif text-xl font-bold">最初の運営アカウントを作成</h1>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">この画面は運営アカウントが1件も無いときに1回だけ使えます。作成後は自動的に無効になります。</p>
      {tokenRequired ? <Field label="セットアップキー" name="token" type="password" autoComplete="off" error={err.token} hint="Vercel の環境変数 ADMIN_SETUP_TOKEN に設定した値" /> : null}
      <Field label="お名前（任意）" name="name" type="text" autoComplete="name" error={err.name} required={false} />
      <Field label="メールアドレス" name="email" type="email" autoComplete="username" error={err.email} />
      <Field label="パスワード" name="password" type="password" autoComplete="new-password" error={err.password} hint="10文字以上・英字と数字を両方含める" />
      <Field label="パスワード（確認）" name="passwordConfirm" type="password" autoComplete="new-password" error={err.passwordConfirm} />
      {state?.status === "error" && state.message ? (
        <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {state.message}
        </p>
      ) : null}
      <button disabled={pending} className="btn-gold mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl font-bold">
        {pending ? <Spinner className="h-4 w-4" /> : null}
        運営アカウントを作成
      </button>
    </form>
  );
}
