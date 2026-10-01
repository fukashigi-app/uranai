"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { FortuneTypeValue } from "@/lib/db/schema";
import { BLOOD_TYPES, ZODIAC_SIGNS } from "@/lib/fortune/zodiac";
import { CelestialLoader } from "@/components/ui/spinner";

const MIN_ANIMATION_MS = 2400;

export function FortuneInputForm({ type }: { type: FortuneTypeValue }) {
  const router = useRouter();
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [sign, setSign] = useState<string | null>(null);
  const [blood, setBlood] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const thisYear = new Date().getFullYear();
  const years = useMemo(() => Array.from({ length: thisYear - 1900 + 1 }, (_, i) => String(thisYear - i)), [thisYear]);
  const daysInMonth = year && month ? new Date(Number(year), Number(month), 0).getDate() : 31;

  const ready = type === "BIRTHDAY" ? Boolean(year && month && day && Number(day) <= daysInMonth) : type === "ZODIAC" ? Boolean(sign) : Boolean(blood);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || reading) return;
    setError(null);
    setReading(true);
    const body =
      type === "BIRTHDAY"
        ? { type, birthDate: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` }
        : type === "ZODIAC"
          ? { type, sign }
          : { type, bloodType: blood };
    const started = Date.now();
    try {
      const res = await fetch("/api/fortune", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setReading(false);
        setError(data?.error?.message ?? "占いを実行できませんでした。もう一度お試しください。");
        return;
      }
      const wait = MIN_ANIMATION_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      router.replace("/fortune/result");
    } catch {
      // 結果がサーバーに保存されている可能性があるため結果ページで確認する
      router.replace("/fortune/result");
    }
  }

  if (reading) {
    return (
      <div className="glass mt-6 rounded-3xl px-6 py-10">
        <CelestialLoader label="星の巡りを読み解いています…" />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="pb-4">
      {type === "BIRTHDAY" ? (
        <fieldset className="glass rounded-3xl p-5">
          <legend className="sr-only">生年月日</legend>
          <p className="mb-3 text-[13px] text-ink-muted">生年月日を選んでください</p>
          <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2">
            <Select label="年" value={year} onChange={setYear} options={years} suffix="年" />
            <Select label="月" value={month} onChange={setMonth} options={Array.from({ length: 12 }, (_, i) => String(i + 1))} suffix="月" />
            <Select label="日" value={day} onChange={setDay} options={Array.from({ length: daysInMonth }, (_, i) => String(i + 1))} suffix="日" />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">生年月日は占いの計算にのみ使用し、保存しません。</p>
        </fieldset>
      ) : null}

      {type === "ZODIAC" ? (
        <fieldset>
          <legend className="mb-3 text-[13px] text-ink-muted">あなたの星座を選んでください</legend>
          <div className="grid grid-cols-3 gap-2.5" role="radiogroup">
            {ZODIAC_SIGNS.map((s) => {
              const active = sign === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSign(s.key)}
                  className={`glass flex flex-col items-center rounded-2xl px-1 py-3 transition-all active:scale-95 ${active ? "!border-gold-300/80 bg-gold-300/10" : ""}`}
                >
                  <span className={`text-2xl leading-none ${active ? "text-gold-200" : "text-gold-300/80"}`}>{`${s.symbol}\uFE0E`}</span>
                  <span className="mt-1.5 text-[13px] font-bold">{s.name}</span>
                  <span className="mt-0.5 text-[10px] text-ink-faint">{s.range}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {type === "BLOOD" ? (
        <fieldset>
          <legend className="mb-3 text-[13px] text-ink-muted">あなたの血液型を選んでください</legend>
          <div className="grid grid-cols-2 gap-3" role="radiogroup">
            {BLOOD_TYPES.map((b) => {
              const active = blood === b;
              return (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setBlood(b)}
                  className={`glass flex h-24 flex-col items-center justify-center rounded-3xl transition-all active:scale-95 ${active ? "!border-gold-300/80 bg-gold-300/10" : ""}`}
                >
                  <span className={`font-display text-4xl font-semibold ${active ? "text-gold-200" : "text-ink"}`}>{b}</span>
                  <span className="text-[11px] text-ink-muted">型</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={!ready} className="btn-gold mt-6 h-14 w-full rounded-2xl text-base font-bold tracking-widest">
        占う
      </button>
      <p className="mt-2 text-center text-[11px] text-ink-faint">※ 1回のお支払いにつき1回占えます</p>
    </form>
  );
}

function Select({ label, value, onChange, options, suffix }: { label: string; value: string; onChange: (v: string) => void; options: string[]; suffix: string }) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select className="field h-12" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{label}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
            {suffix}
          </option>
        ))}
      </select>
    </label>
  );
}
