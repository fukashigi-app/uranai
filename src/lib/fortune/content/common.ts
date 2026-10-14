import type { Tagged } from "../select";

/**
 * 3種類の占いで共通に使う「ラッキー系」（色・アイテム・時間帯）だけを置く。
 * 運勢の文章・行動・注意・整えるヒントは、口調と内容を書き分けるため占いごとに別ファイルにする
 * （tests/fortune-similarity.test.ts で、占いどうしの本文に同じ文・ほぼ同じ文が無いことを確かめている）。
 *
 * 札の付け方:
 *  season: ["spring","summer","autumn","winter"] のうち使ってよい季節（省略＝通年）
 *  time:   ["morning","day","night"] のうち使ってよい時間帯（省略＝いつでも）
 *  tone:   ["high","mid","low"] 好調・普通・控えめのどの日に使ってよいか（省略＝どの日でも）
 */

export const LUCKY_COLORS: readonly { name: string; hex: string }[] = [
  { name: "ミッドナイトネイビー", hex: "#1e2a5a" },
  { name: "シャンパンゴールド", hex: "#d8c08a" },
  { name: "ラベンダー", hex: "#b7a3e0" },
  { name: "ボルドー", hex: "#7a2234" },
  { name: "エメラルドグリーン", hex: "#2f9e7d" },
  { name: "パールホワイト", hex: "#f3efe6" },
  { name: "スカイブルー", hex: "#7fb8e6" },
  { name: "テラコッタ", hex: "#c4673f" },
  { name: "ローズピンク", hex: "#e08aa5" },
  { name: "シルバー", hex: "#c2c7d0" },
  { name: "マスタードイエロー", hex: "#d9a72b" },
  { name: "オリーブ", hex: "#7d8445" },
  { name: "アイボリー", hex: "#efe6cf" },
  { name: "ディープパープル", hex: "#4b2a7a" },
  { name: "ターコイズ", hex: "#3bb6b0" },
  { name: "チャコールグレー", hex: "#3c3f47" },
  { name: "コーラルオレンジ", hex: "#f08a5d" },
  { name: "ミントグリーン", hex: "#9fdcc3" },
];

const WARM = ["autumn", "winter"] as const;
const COOL = ["spring", "summer"] as const;

export const LUCKY_ITEMS: readonly Tagged[] = [
  { text: "腕時計" },
  { text: "万年筆" },
  { text: "ハンカチ" },
  { text: "手帳" },
  { text: "キャンドル", season: WARM },
  { text: "リップクリーム" },
  { text: "イヤホン" },
  { text: "ブックカバー" },
  { text: "マグカップ" },
  { text: "ポーチ" },
  { text: "折りたたみ傘", season: ["spring", "summer", "autumn"] },
  { text: "香水" },
  { text: "ヘアクリップ" },
  { text: "スニーカー" },
  { text: "小さな観葉植物" },
  { text: "ガラスのコースター", season: COOL },
  { text: "レザーの小物" },
  { text: "パールのアクセサリー" },
  { text: "好きな作家の文庫本" },
  { text: "チョコレート" },
  { text: "ハーブティー" },
  { text: "星モチーフのアクセサリー" },
  { text: "お気に入りのペン" },
  { text: "キーケース" },
  { text: "ストール", season: ["autumn", "winter", "spring"] },
  { text: "ハンドクリーム", season: WARM },
  { text: "トートバッグ" },
  { text: "シルバーのリング" },
  { text: "ポストカード" },
  { text: "アロマオイル" },
  { text: "小さな鏡" },
  { text: "季節の花" },
  { text: "ミントタブレット" },
  { text: "マフラー", season: ["winter"] },
  { text: "手袋", season: ["winter"] },
  { text: "扇子", season: ["summer"] },
  { text: "サングラス", season: ["spring", "summer"] },
  { text: "麦わら素材の小物", season: ["summer"] },
  { text: "ニットの小物", season: WARM },
  { text: "桜モチーフの小物", season: ["spring"] },
  { text: "どんぐりや木の実モチーフの小物", season: ["autumn"] },
  { text: "冷たいお茶のボトル", season: ["summer"] },
  { text: "温かいお茶のボトル", season: WARM },
  { text: "お守り" },
  { text: "白いシャツ" },
  { text: "ガラスペン" },
  { text: "月モチーフのアクセサリー" },
];

/** ラッキータイムの時間帯（開始・終了は時）。結果を作った時刻より後のものだけを使う */
export const LUCKY_TIME_WINDOWS: readonly [number, number][] = [
  [7, 9],
  [9, 11],
  [11, 13],
  [13, 15],
  [15, 17],
  [17, 19],
  [19, 21],
  [21, 23],
];
