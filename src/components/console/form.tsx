"use client";

import { useActionState } from "react";
import { Spinner } from "@/components/ui/spinner";

export type FormState = { ok?: boolean; message?: string; errors?: Record<string, string> } | null;

/** Server Action をフォームに接続（送信中は二重送信不可、結果メッセージ表示） */
export function ActionForm({
  action,
  children,
  submitLabel,
  className = "",
  confirmMessage,
  variant = "gold",
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children?: React.ReactNode | ((state: FormState) => React.ReactNode);
  submitLabel: string;
  className?: string;
  confirmMessage?: string;
  variant?: "gold" | "ghost" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const btn =
    variant === "gold" ? "btn-gold" : variant === "danger" ? "border border-danger/40 text-danger hover:bg-danger/10" : "btn-ghost";
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {typeof children === "function" ? children(state) : children}
      {state?.message ? (
        <p role={state.ok ? "status" : "alert"} className={`mt-3 rounded-xl px-3 py-2 text-[13px] ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
          {state.message}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={`${btn} mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl px-6 text-sm font-bold disabled:opacity-60`}>
        {pending ? <Spinner className="h-4 w-4" /> : null}
        {submitLabel}
      </button>
    </form>
  );
}

export function Field({
  label,
  name,
  defaultValue,
  error,
  type = "text",
  required,
  placeholder,
  autoComplete,
  inputMode,
  hint,
  maxLength,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  error?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "email" | "tel";
  hint?: string;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-ink-muted">
        {label}
        {required ? <span className="ml-1 text-gold-300">*</span> : null}
      </span>
      <input
        className={`field ${error ? "!border-danger/60" : ""}`}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
      />
      {error ? <span className="mt-1 block text-[12px] text-danger">{error}</span> : hint ? <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

export function SelectField({ label, name, defaultValue, options, error }: { label: string; name: string; defaultValue?: string; options: readonly string[]; error?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-ink-muted">{label}</span>
      <select name={name} defaultValue={defaultValue} className="field">
        <option value="">選択してください</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {error ? <span className="mt-1 block text-[12px] text-danger">{error}</span> : null}
    </label>
  );
}
