export const ZODIAC_SIGNS = [
  { key: "aries", name: "おひつじ座", symbol: "♈", range: "3/21〜4/19", element: "fire" },
  { key: "taurus", name: "おうし座", symbol: "♉", range: "4/20〜5/20", element: "earth" },
  { key: "gemini", name: "ふたご座", symbol: "♊", range: "5/21〜6/21", element: "air" },
  { key: "cancer", name: "かに座", symbol: "♋", range: "6/22〜7/22", element: "water" },
  { key: "leo", name: "しし座", symbol: "♌", range: "7/23〜8/22", element: "fire" },
  { key: "virgo", name: "おとめ座", symbol: "♍", range: "8/23〜9/22", element: "earth" },
  { key: "libra", name: "てんびん座", symbol: "♎", range: "9/23〜10/23", element: "air" },
  { key: "scorpio", name: "さそり座", symbol: "♏", range: "10/24〜11/22", element: "water" },
  { key: "sagittarius", name: "いて座", symbol: "♐", range: "11/23〜12/21", element: "fire" },
  { key: "capricorn", name: "やぎ座", symbol: "♑", range: "12/22〜1/19", element: "earth" },
  { key: "aquarius", name: "みずがめ座", symbol: "♒", range: "1/20〜2/18", element: "air" },
  { key: "pisces", name: "うお座", symbol: "♓", range: "2/19〜3/20", element: "water" },
] as const;

export type ZodiacKey = (typeof ZODIAC_SIGNS)[number]["key"];
export const ZODIAC_KEYS = ZODIAC_SIGNS.map((s) => s.key) as [ZodiacKey, ...ZodiacKey[]];

export const BLOOD_TYPES = ["A", "B", "O", "AB"] as const;
export type BloodType = (typeof BLOOD_TYPES)[number];

/** 月日 → 星座（境界は一般的な区分） */
export function zodiacFromDate(month: number, day: number): ZodiacKey {
  const md = month * 100 + day;
  if (md >= 321 && md <= 419) return "aries";
  if (md >= 420 && md <= 520) return "taurus";
  if (md >= 521 && md <= 621) return "gemini";
  if (md >= 622 && md <= 722) return "cancer";
  if (md >= 723 && md <= 822) return "leo";
  if (md >= 823 && md <= 922) return "virgo";
  if (md >= 923 && md <= 1023) return "libra";
  if (md >= 1024 && md <= 1122) return "scorpio";
  if (md >= 1123 && md <= 1221) return "sagittarius";
  if (md >= 1222 || md <= 119) return "capricorn";
  if (md >= 120 && md <= 218) return "aquarius";
  return "pisces";
}

export function zodiacInfo(key: ZodiacKey) {
  return ZODIAC_SIGNS.find((s) => s.key === key)!;
}

/** 数秘術の誕生数（1〜9、11/22/33はマスターナンバーとして保持） */
export function lifePathNumber(y: number, m: number, d: number): number {
  let n = `${y}${m}${d}`.split("").reduce((s, c) => s + Number(c), 0);
  while (n > 9 && n !== 11 && n !== 22 && n !== 33) {
    n = String(n)
      .split("")
      .reduce((s, c) => s + Number(c), 0);
  }
  return n;
}

export function isValidBirthDate(v: string, today = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false;
  return y >= 1900 && date.getTime() <= today.getTime();
}
