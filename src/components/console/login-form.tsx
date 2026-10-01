"use client";

import { useActionState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Logo } from "@/components/ui/logo";
import type { FormState } from "./form";

export function LoginForm({ action, badge, title }: { action: (prev: FormState, fd: FormData) => Promise<FormState>; badge: string; title: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <form action={formAction} className="glass w-full max-w-sm rounded-3xl p-7 fade-up">
        <Logo sub={badge} />
        <h1 className="mt-6 font-serif text-xl font-bold">{title}</h1>
        <label className="mt-6 block">
          <span className="mb-1.5 block text-[12px] text-ink-muted">メールアドレス</span>
          <input name="email" type="email" required autoComplete="username" className="field" inputMode="email" />
        </label>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12px] text-ink-muted">パスワード</span>
          <input name="password" type="password" required autoComplete="current-password" className="field" />
        </label>
        {state?.message ? (
          <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.message}
          </p>
        ) : null}
        <button disabled={pending} className="btn-gold mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl font-bold">
          {pending ? <Spinner className="h-4 w-4" /> : null}
          ログイン
        </button>
      </form>
    </div>
  );
}
