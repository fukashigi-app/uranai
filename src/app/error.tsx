"use client";

import { useEffect } from "react";
import { ErrorPanel } from "@/components/public/error-panel";

/** 画面の表示中に予期しないエラーが起きた場合（DB接続エラーなど）。白画面にせず案内を出す */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <ErrorPanel title="うまく表示できませんでした" message="通信状況や混雑により、ページを表示できませんでした。お手数ですが、最初からやり直してください。">
      <button type="button" onClick={reset} className="text-[12px] text-ink-muted underline underline-offset-4">
        もう一度読み込む
      </button>
    </ErrorPanel>
  );
}
