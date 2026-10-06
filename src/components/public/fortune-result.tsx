import type { FortuneResultData } from "@/lib/db/schema";
import { revealStorageKey } from "@/lib/fortune/reveal";
import { ResultView } from "./result-view";
import { RevealStage, type RevealMode } from "./reveal-stage";

/**
 * 占い結果の表示（3種類共通）：レア度演出 → 各占い専用の結果画面。
 * 旧形式の保存結果（レア度なし）は演出なしでそのまま表示する。
 */
export function FortuneResult({ result, mode = "auto", footer }: { result: FortuneResultData; mode?: RevealMode; footer?: React.ReactNode }) {
  const rarity = result.v === 2 ? { key: result.rarity.key, level: result.rarity.level, en: result.rarity.en, ja: result.rarity.ja, tagline: result.rarity.tagline } : undefined;
  return (
    <RevealStage storageKey={revealStorageKey(result)} rarity={rarity} mode={mode}>
      <ResultView result={result} />
      {footer}
    </RevealStage>
  );
}
