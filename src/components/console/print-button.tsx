"use client";

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-lg bg-neutral-900 px-4 py-2 text-white">
      印刷する
    </button>
  );
}
