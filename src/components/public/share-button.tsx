"use client";

import { useState } from "react";

/** 結果を共有（URLには権利トークンを含めない。トップページのURLのみ共有する） */
export function ShareButton({ text, url }: { text: string; url: string }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* キャンセル */
    }
  }
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  return (
    <div className="grid grid-cols-2 gap-3">
      <button type="button" onClick={share} className="btn-ghost h-12 rounded-2xl text-sm">
        {copied ? "コピーしました" : "結果をシェア"}
      </button>
      <a href={xUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost flex h-12 items-center justify-center rounded-2xl text-sm">
        Xでポスト
      </a>
    </div>
  );
}
