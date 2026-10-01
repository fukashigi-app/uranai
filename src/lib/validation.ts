import { z } from "zod";

const trimmed = (max: number) => z.string().trim().max(max, `${max}文字以内で入力してください`);

export const storeProfileSchema = z.object({
  name: trimmed(100).min(1, "店舗名を入力してください"),
  contactName: trimmed(100),
  postalCode: z
    .string()
    .trim()
    .transform((v) => v.replace(/[－ー−]/g, "-"))
    .refine((v) => v === "" || /^\d{3}-?\d{4}$/.test(v), "郵便番号は 123-4567 の形式で入力してください"),
  address: trimmed(300),
  phone: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[0-9+\-() ]{10,20}$/.test(v), "電話番号を正しく入力してください"),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === "" || z.email().safeParse(v).success, "メールアドレスを正しく入力してください"),
});
export type StoreProfileInput = z.infer<typeof storeProfileSchema>;

export const ACCOUNT_TYPES = ["普通", "当座", "貯蓄"] as const;

export const bankInfoSchema = z.object({
  bankName: trimmed(50).min(1, "銀行名を入力してください"),
  bankCode: z.string().trim().regex(/^\d{4}$/, "金融機関コードは4桁の数字です"),
  branchName: trimmed(50).min(1, "支店名を入力してください"),
  branchCode: z.string().trim().regex(/^\d{3}$/, "支店コードは3桁の数字です"),
  accountType: z.enum(ACCOUNT_TYPES, { message: "口座種別を選択してください" }),
  accountNumber: z.string().trim().regex(/^\d{7}$/, "口座番号は7桁の数字です"),
  accountHolder: z
    .string()
    .trim()
    .min(1, "口座名義を入力してください")
    .max(60)
    .regex(/^[ァ-ヶー・（）()0-9A-Z\s.,\-/]+$/u, "口座名義は全角カタカナで入力してください"),
});
export type BankInfo = z.infer<typeof bankInfoSchema>;

export const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

export const newStoreUserSchema = z.object({
  name: trimmed(100).min(1, "担当者名を入力してください"),
  email: z.email("メールアドレスを正しく入力してください").max(254),
  password: z.string().min(10, "パスワードは10文字以上").max(200),
});

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const k = String(issue.path[0] ?? "_");
    out[k] ??= issue.message;
  }
  return out;
}
