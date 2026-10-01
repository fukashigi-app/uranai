"use client";

import { useState } from "react";

export type BarDatum = { label: string; value: number; detail?: string };

/**
 * 単一系列の縦棒グラフ（SVG）。凡例はタイトルが兼ねる。
 * 棒は最大24px・上端4px角丸・ベースライン起点、ホバー/タップでツールチップ、表でも確認可能。
 */
export function BarChart({
  data,
  title,
  unit = "件",
  tickEvery = 1,
}: {
  data: BarDatum[];
  title: string;
  unit?: string;
  /** X軸ラベルを何本おきに出すか */
  tickEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 200;
  const pad = { l: 36, r: 8, t: 12, b: 26 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const niceMax = niceCeil(max);
  const ticks = [0, niceMax / 2, niceMax];
  const band = (W - pad.l - pad.r) / data.length;
  const barW = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / niceMax);
  const base = y(0);
  const h = hover !== null ? data[hover] : null;

  return (
    <figure className="relative">
      <figcaption className="mb-2 text-[13px] font-bold text-ink">{title}</figcaption>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}のグラフ`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-faint)">
                {t.toLocaleString("ja-JP")}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + band * i + (band - barW) / 2;
            const top = y(d.value);
            const bh = Math.max(0, base - top);
            const r = Math.min(4, bh, barW / 2);
            return (
              <g key={d.label}>
                {bh > 0 ? (
                  <path
                    d={`M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z`}
                    fill={hover === i ? "var(--gold-200)" : "var(--gold-400)"}
                  />
                ) : null}
                {/* 棒より広いヒット領域 */}
                <rect
                  x={pad.l + band * i}
                  y={pad.t}
                  width={band}
                  height={H - pad.t - pad.b}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                />
                {i % tickEvery === 0 ? (
                  <text x={pad.l + band * i + band / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--ink-faint)">
                    {d.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {h && hover !== null ? (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg border border-white/15 bg-night-900/95 px-2.5 py-1.5 text-[12px] shadow-lg"
            style={{ left: `${((pad.l + band * hover + band / 2) / W) * 100}%` }}
          >
            <p className="text-ink-muted">{h.detail ?? h.label}</p>
            <p className="font-bold text-ink">
              {h.value.toLocaleString("ja-JP")}
              {unit}
            </p>
          </div>
        ) : null}
      </div>
      <details className="mt-2 text-[12px] text-ink-muted">
        <summary className="cursor-pointer select-none">表で見る</summary>
        <table className="mt-2 w-full">
          <tbody>
            {data.map((d) => (
              <tr key={d.label} className="border-t border-white/5">
                <td className="py-1">{d.detail ?? d.label}</td>
                <td className="py-1 text-right tabular-nums">
                  {d.value.toLocaleString("ja-JP")}
                  {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function niceCeil(v: number): number {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}
