"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/**
 * ブラウザの Cookie が無効だと、お支払い・占う権利・結果をこのブラウザに結びつけられない。
 * QRコードから何度やり直しても解決しないため、無効なときだけ画面上部で案内する。
 */
export function CookieHint() {
  const enabled = useSyncExternalStore(
    noop,
    () => navigator.cookieEnabled,
    () => true,
  );
  if (enabled) return null;
  return (
    <p role="alert" className="mb-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-center text-[12px] leading-relaxed text-danger">
      ブラウザのCookieが無効になっています。
      <span className="block">Cookieを有効にして、もう一度お試しください。</span>
    </p>
  );
}
