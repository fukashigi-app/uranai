"use client";

import { useActionState } from "react";
import { ActionForm, Field, type FormState } from "./form";
import { Spinner } from "@/components/ui/spinner";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

export function NewStoreForm({ action }: { action: Action }) {
  return (
    <ActionForm action={action} submitLabel="店舗を作成する">
      {(s) => (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="店舗名" name="name" error={s?.errors?.name} required />
            <Field label="担当者名" name="contactName" error={s?.errors?.contactName} />
            <Field label="郵便番号" name="postalCode" error={s?.errors?.postalCode} />
            <Field label="電話番号" name="phone" type="tel" error={s?.errors?.phone} />
            <div className="sm:col-span-2">
              <Field label="住所" name="address" error={s?.errors?.address} />
            </div>
            <div className="sm:col-span-2">
              <Field label="店舗メールアドレス" name="email" type="email" error={s?.errors?.email} />
            </div>
          </div>
          <fieldset className="rounded-2xl border border-white/10 p-4">
            <legend className="px-2 text-[13px] text-ink-muted">店舗ログインアカウント（任意・後から追加可）</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="氏名" name="userName" error={s?.errors?.userName} />
              <Field label="ログインメール" name="userEmail" type="email" error={s?.errors?.userEmail} autoComplete="off" />
              <Field label="初期パスワード" name="userPassword" type="password" error={s?.errors?.userPassword} autoComplete="new-password" hint="10文字以上・英数字" />
            </div>
          </fieldset>
        </div>
      )}
    </ActionForm>
  );
}

/** フィールド無しの単発アクション（停止・再開・QR再発行など） */
export function ActionButton({ action, label, confirmMessage, variant = "ghost" }: { action: (prev: FormState) => Promise<FormState>; label: string; confirmMessage?: string; variant?: "ghost" | "danger" | "gold" }) {
  const [state, formAction, pending] = useActionState(action, null);
  const cls = variant === "gold" ? "btn-gold" : variant === "danger" ? "border border-danger/40 text-danger hover:bg-danger/10" : "btn-ghost";
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <button disabled={pending} className={`${cls} inline-flex h-10 items-center gap-2 rounded-xl px-4 text-[13px] disabled:opacity-60`}>
        {pending ? <Spinner className="h-4 w-4" /> : null}
        {label}
      </button>
      {state?.message ? <p className={`mt-2 max-w-md break-all text-[12px] ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p> : null}
    </form>
  );
}

export function SettlementRowForm({ action, status, note }: { action: Action; status: string; note: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <select name="status" defaultValue={status} className="field !w-28 !py-1.5 !text-[13px]" aria-label="支払状況">
        <option value="UNPAID">未払い</option>
        <option value="PROCESSING">処理中</option>
        <option value="PAID">支払済</option>
      </select>
      <input name="note" defaultValue={note} placeholder="メモ（振込番号など）" maxLength={1000} className="field !w-40 !py-1.5 !text-[13px]" aria-label="メモ" />
      <button disabled={pending} className="btn-ghost h-9 rounded-lg px-3 text-[12px]">
        {pending ? "…" : "更新"}
      </button>
      {state?.message ? <span className={`text-[11px] ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</span> : null}
    </form>
  );
}

export function StoreAdminProfileForm({ action, values, sharePercent }: { action: Action; values: Record<string, string>; sharePercent: number }) {
  return (
    <ActionForm action={action} submitLabel="保存する">
      {(s) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="店舗名" name="name" defaultValue={values.name} error={s?.errors?.name} required />
          <Field label="担当者名" name="contactName" defaultValue={values.contactName} error={s?.errors?.contactName} />
          <Field label="郵便番号" name="postalCode" defaultValue={values.postalCode} error={s?.errors?.postalCode} />
          <Field label="電話番号" name="phone" defaultValue={values.phone} error={s?.errors?.phone} />
          <div className="sm:col-span-2">
            <Field label="住所" name="address" defaultValue={values.address} error={s?.errors?.address} />
          </div>
          <Field label="メールアドレス" name="email" defaultValue={values.email} error={s?.errors?.email} />
          <Field
            label="店舗配分率（%）"
            name="storeSharePercent"
            defaultValue={String(sharePercent)}
            error={s?.errors?.storeSharePercent}
            inputMode="numeric"
            hint="既定30%。変更は以後の決済にのみ適用されます"
          />
        </div>
      )}
    </ActionForm>
  );
}

export function NewStoreUserForm({ action }: { action: Action }) {
  return (
    <ActionForm action={action} submitLabel="アカウントを追加" variant="ghost">
      {(s) => (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="氏名" name="name" error={s?.errors?.name} required />
          <Field label="ログインメール" name="email" type="email" error={s?.errors?.email} autoComplete="off" required />
          <Field label="初期パスワード" name="password" type="password" error={s?.errors?.password} autoComplete="new-password" required />
        </div>
      )}
    </ActionForm>
  );
}
