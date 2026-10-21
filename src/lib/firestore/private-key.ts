/**
 * FIREBASE_PRIVATE_KEY の表記ゆれを PEM に戻す（Vercel・.env への貼り付け方の違いを吸収）。
 * 他のモジュールに依存しないので、運用スクリプト（check:env・バックアップ）からも使える。
 */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  // 値全体を "..." で囲んで登録してしまった場合
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  // "\n"（バックスラッシュ+n）表記を実際の改行に変換
  return key.replace(/\\n/g, "\n");
}
