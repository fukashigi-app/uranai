/**
 * 運営者情報（特定商取引法に基づく表記・利用規約・プライバシーポリシーに表示）。
 *
 * - サーバー側でのみ読む。氏名・住所・電話番号は個人情報になり得るため NEXT_PUBLIC_ の環境変数は使わない
 *   （以前の NEXT_PUBLIC_OPERATOR_* も読み取るが、移行を促す通知を出す）。
 * - 屋号と問い合わせ先は確定済みの公開情報なので既定値として持つ。
 * - 仮の値（example.com・【…】など）が設定されている場合は表示に使わず、設定の不備として報告する。
 * - 氏名・住所・電話番号は架空の値で埋めない。未設定なら「請求があれば開示」と表示し、
 *   その方式が法令上の条件を満たすかは未確認である旨を通知する（公開前に要確認）。
 *
 * next.config.ts からも読み込むため、このファイルは他のモジュールに依存しないこと。
 */

export const OPERATOR_DEFAULTS = {
  tradeName: "Hobby shop FUKASHIGI",
  businessType: "個人事業主",
  email: "koyomi100yen@gmail.com",
} as const;

export type OperatorInfo = {
  /** 屋号 */
  tradeName: string;
  businessType: string;
  /** 問い合わせ先メールアドレス */
  email: string;
  /** 事業者の氏名（未設定なら null = 請求時開示の表示） */
  ownerName: string | null;
  address: string | null;
  phone: string | null;
};

export type OperatorIssue = {
  /** error = 設定の不備（仮の値・形式の誤り）。notice = 公開前に確認が必要な事項 */
  level: "error" | "notice";
  key: string;
  message: string;
};

type Env = Record<string, string | undefined>;

/** 仮の値とみなす文字列 */
const PLACEHOLDER = /example\.(com|org|net|test|jp)|【|】|設定してください|要設定|要確認|placeholder|dummy|xxx|^-+$|^未定$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9０-９+\-－() ]{10,20}$/;

type Field = {
  label: string;
  keys: [current: string, legacy: string];
  validate?: (v: string) => boolean;
};

const FIELDS = {
  tradeName: { label: "屋号", keys: ["OPERATOR_TRADE_NAME", "NEXT_PUBLIC_OPERATOR_NAME"] },
  email: { label: "問い合わせ先メールアドレス", keys: ["OPERATOR_EMAIL", "NEXT_PUBLIC_OPERATOR_EMAIL"], validate: (v) => EMAIL.test(v) },
  ownerName: { label: "事業者の氏名", keys: ["OPERATOR_OWNER_NAME", "NEXT_PUBLIC_OPERATOR_REPRESENTATIVE"] },
  address: { label: "所在地", keys: ["OPERATOR_ADDRESS", "NEXT_PUBLIC_OPERATOR_ADDRESS"] },
  phone: { label: "電話番号", keys: ["OPERATOR_PHONE", "NEXT_PUBLIC_OPERATOR_PHONE"], validate: (v) => PHONE.test(v) },
} satisfies Record<string, Field>;

function read(env: Env, field: Field, issues: OperatorIssue[]): string | null {
  for (const key of field.keys) {
    const v = env[key]?.trim();
    if (!v) continue;
    if (PLACEHOLDER.test(v) || (field.validate && !field.validate(v))) {
      // 値そのものは出力しない（個人情報の可能性があるため）
      issues.push({ level: "error", key, message: `${key}（${field.label}）に仮の値または正しくない形式の値が設定されているため、表示に使っていません。` });
      continue;
    }
    if (key.startsWith("NEXT_PUBLIC_")) {
      issues.push({
        level: "notice",
        key,
        message: `${key} は以前の設定名です。ブラウザに公開される名前のため、${field.keys[0]} に移して ${key} は削除してください。`,
      });
    }
    return v;
  }
  return null;
}

export function readOperatorInfo(env: Env = process.env): { info: OperatorInfo; issues: OperatorIssue[] } {
  const issues: OperatorIssue[] = [];
  const info: OperatorInfo = {
    tradeName: read(env, FIELDS.tradeName, issues) ?? OPERATOR_DEFAULTS.tradeName,
    businessType: OPERATOR_DEFAULTS.businessType,
    email: read(env, FIELDS.email, issues) ?? OPERATOR_DEFAULTS.email,
    ownerName: read(env, FIELDS.ownerName, issues),
    address: read(env, FIELDS.address, issues),
    phone: read(env, FIELDS.phone, issues),
  };
  const undisclosed = (["ownerName", "address", "phone"] as const).filter((k) => !info[k]).map((k) => FIELDS[k].label);
  if (undisclosed.length) {
    issues.push({
      level: "notice",
      key: "disclosure",
      message: `${undisclosed.join("・")}は「ご請求があれば遅滞なく開示」と表示しています。この方式が法令上の条件を満たすか（特定商取引法・個人情報保護法）は未確認です。公開前に確認してください。`,
    });
  }
  return { info, issues };
}

/** 表示に使う値が仮の値でないことの最終確認（テスト・ヘルスチェック用） */
export function looksLikePlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}
