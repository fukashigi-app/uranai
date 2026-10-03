/**
 * 本番用の運営アカウント作成。
 *   ADMIN_EMAIL=ops@example.com ADMIN_NAME=運営 ADMIN_PASSWORD='...' npm run admin:create
 */
import "dotenv/config";
import { validatePasswordStrength } from "@/lib/auth/password";
import { createOperator, DuplicateEmailError } from "@/lib/services/stores";
import { dataProvider } from "@/lib/data-provider";

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME ?? "運営管理者";
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required");
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  try {
    const id = await createOperator({ email, password, name });
    console.log(`運営アカウントを作成しました（保存先: ${dataProvider()}）: ${email} / id=${id}`);
  } catch (e) {
    if (e instanceof DuplicateEmailError) throw new Error(`このメールアドレスのアカウントは既にあります: ${email}`);
    throw e;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
