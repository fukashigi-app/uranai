/**
 * Stripe Checkout の戻り先（success_url・cancel_url）のオリジンを決める（純粋な判定。単体テスト用に分けている）。
 *
 * 決済を始めた画面と同じドメインに戻す（注文の Cookie はドメインごとなので、別のドメインに戻ると照合できない）。
 * ただし、要求の Origin はそのまま信用しない。次のすべてを満たすときだけ使い、それ以外は公開URL（APP_URL）に戻す：
 *  - 呼び出し側で同一オリジンの確認（isSameOrigin）を済ませていること（ここでは確認しない）
 *  - このデプロイ自身の URL のどれかと完全に一致すること（APP_URL・VERCEL_URL・VERCEL_BRANCH_URL）。
 *    他人のサイト・vercel.app の別のプロジェクトには戻さない（外部サイトへのリダイレクトを防ぐ）
 *  - https であること。http はローカルの自動テスト（localhost・127.0.0.1）だけ
 *  - パス・ユーザー名・パスワードなどを含まない、オリジンだけの値であること
 */
type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/** "https://host" の形だけを受け付けて、小文字のオリジンにする。それ以外は null */
function strictOrigin(value: string, allowLoopbackHttp: boolean): string | null {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(value)) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol === "https:") return u.origin.toLowerCase();
  if (u.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(u.hostname)) return u.origin.toLowerCase();
  return null;
}

/** Vercel の環境変数のホスト名（"host" または "https://host"）を https のオリジンにする */
function vercelOrigin(host: string | undefined): string | null {
  const h = (host ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return h ? strictOrigin(`https://${h}`, false) : null;
}

/**
 * @param requestOrigin 要求の Origin ヘッダー（同一オリジンの確認済み）。無ければ null
 * @param appUrl 公開URL（env().APP_URL）。許可されないときの戻り先
 * @param mode Stripe のテスト決済の実行場所。ローカルの自動テストだけ http の localhost・127.0.0.1 を許可する
 */
export function stripeReturnOrigin(requestOrigin: string | null, appUrl: string, mode: "preview" | "local", e: Env = process.env): string {
  const fallback = new URL(appUrl).origin;
  if (!requestOrigin) return fallback;
  const candidate = strictOrigin(requestOrigin.trim(), mode === "local");
  if (!candidate) return fallback;
  const allowed = new Set<string>();
  const app = strictOrigin(fallback, mode === "local");
  if (app) allowed.add(app);
  for (const h of [e.VERCEL_URL, e.VERCEL_BRANCH_URL]) {
    const o = vercelOrigin(h);
    if (o) allowed.add(o);
  }
  if (mode === "local" && LOOPBACK.has(new URL(candidate).hostname)) allowed.add(candidate);
  return allowed.has(candidate) ? candidate : fallback;
}
