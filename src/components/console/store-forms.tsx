"use client";

import { ActionForm, Field, SelectField, type FormState } from "./form";
import { ACCOUNT_TYPES } from "@/lib/validation";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

export type ProfileValues = { name: string; contactName: string; postalCode: string; address: string; phone: string; email: string };

export function StoreProfileForm({ action, values }: { action: Action; values: ProfileValues }) {
  return (
    <ActionForm action={action} submitLabel="保存する">
      {(s) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="店舗名" name="name" defaultValue={values.name} error={s?.errors?.name} required maxLength={100} />
          <Field label="担当者名" name="contactName" defaultValue={values.contactName} error={s?.errors?.contactName} maxLength={100} />
          <Field label="郵便番号" name="postalCode" defaultValue={values.postalCode} error={s?.errors?.postalCode} placeholder="150-0001" inputMode="numeric" />
          <Field label="電話番号" name="phone" defaultValue={values.phone} error={s?.errors?.phone} type="tel" inputMode="tel" />
          <div className="sm:col-span-2">
            <Field label="住所" name="address" defaultValue={values.address} error={s?.errors?.address} maxLength={300} />
          </div>
          <div className="sm:col-span-2">
            <Field label="メールアドレス" name="email" defaultValue={values.email} error={s?.errors?.email} type="email" inputMode="email" />
          </div>
        </div>
      )}
    </ActionForm>
  );
}

export type BankDefaults = { bankName: string; bankCode: string; branchName: string; branchCode: string; accountType: string; accountHolder: string } | null;

export function BankForm({ action, defaults, requirePassword = true }: { action: Action; defaults: BankDefaults; requirePassword?: boolean }) {
  return (
    <ActionForm action={action} submitLabel="振込先を保存する" confirmMessage="振込先を変更します。よろしいですか？">
      {(s) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="銀行名" name="bankName" defaultValue={defaults?.bankName} error={s?.errors?.bankName} required />
          <Field label="金融機関コード（4桁）" name="bankCode" defaultValue={defaults?.bankCode} error={s?.errors?.bankCode} inputMode="numeric" maxLength={4} required />
          <Field label="支店名" name="branchName" defaultValue={defaults?.branchName} error={s?.errors?.branchName} required />
          <Field label="支店コード（3桁）" name="branchCode" defaultValue={defaults?.branchCode} error={s?.errors?.branchCode} inputMode="numeric" maxLength={3} required />
          <SelectField label="口座種別" name="accountType" defaultValue={defaults?.accountType} options={ACCOUNT_TYPES} error={s?.errors?.accountType} />
          <Field
            label="口座番号（7桁）"
            name="accountNumber"
            error={s?.errors?.accountNumber}
            inputMode="numeric"
            maxLength={7}
            autoComplete="off"
            required
            hint="セキュリティのため、保存済みの口座番号は表示されません。変更時は全桁を入力してください。"
          />
          <div className="sm:col-span-2">
            <Field label="口座名義（全角カタカナ）" name="accountHolder" defaultValue={defaults?.accountHolder} error={s?.errors?.accountHolder} placeholder="カ）ルナ" required />
          </div>
          {requirePassword ? (
            <div className="sm:col-span-2">
              <Field label="ログインパスワード（本人確認）" name="currentPassword" type="password" autoComplete="current-password" error={s?.errors?.currentPassword} required />
            </div>
          ) : null}
        </div>
      )}
    </ActionForm>
  );
}

export function PasswordForm({ action }: { action: Action }) {
  return (
    <ActionForm action={action} submitLabel="パスワードを変更" variant="ghost">
      {(s) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="現在のパスワード" name="currentPassword" type="password" autoComplete="current-password" error={s?.errors?.currentPassword} required />
          <Field label="新しいパスワード" name="newPassword" type="password" autoComplete="new-password" error={s?.errors?.newPassword} hint="10文字以上・英字と数字を含む" required />
        </div>
      )}
    </ActionForm>
  );
}
