/**
 * 開発用プレビュー（/dev/fortune-preview）を使えるか。
 *  - 本番（Vercel Production）では、設定に関係なく常に使えない
 *  - 手元の開発環境（npm run dev）では使える
 *  - Vercel のプレビュー環境では ENABLE_FORTUNE_PREVIEW=true のときだけ
 * プレビューは見本の結果を表示するだけで、本物の占い・決済・保存には一切関係しない。
 */
export function isFortunePreviewEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") return false;
  if (process.env.NODE_ENV === "development") return true;
  return process.env.VERCEL_ENV === "preview" && process.env.ENABLE_FORTUNE_PREVIEW === "true";
}
