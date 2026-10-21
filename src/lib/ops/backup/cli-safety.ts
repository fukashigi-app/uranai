/**
 * バックアップのコマンド（scripts/firestore-backup.ts）で使う、OS に依存しやすい処理。
 *  - ファイルがリポジトリの中にあるかの判定（Windows の「C:/…」と「C:\…」の違い、大文字・小文字の違いに対応）
 *  - 合言葉の入力（表示しない）：貼り付け・Enter・Backspace を1文字ずつ処理する
 */
import nodePath from "node:path";

type PathImpl = Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep">;

/**
 * target が dir の中（dir 自身を含む）にあるか。
 * 文字列の前方一致ではなく path.relative で比べる（Windows では区切り文字が混在し、大文字・小文字を区別しないため）。
 */
export function isInsideDir(dir: string, target: string, p: PathImpl = nodePath): boolean {
  const rel = p.relative(p.resolve(dir), p.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** git に渡す、リポジトリのトップからの相対パス（区切りは /） */
export function toGitRelativePath(top: string, target: string, p: PathImpl = nodePath): string {
  return p.relative(p.resolve(top), p.resolve(target)).split(p.sep).join("/");
}

export type HiddenInputState = { status: "pending" } | { status: "done"; value: string } | { status: "interrupt" };

/**
 * 表示しない入力を1文字ずつ組み立てる。端末から届く1回分のデータに複数の文字が入っていても正しく扱う。
 *  - Enter（\r / \n / \r\n）で確定。確定より後ろの文字は使わない
 *  - Backspace（Mac・Linux は \x7f、Windows は \b）で1文字消す（絵文字などのサロゲートペアも1文字として扱う）
 *  - Ctrl+C（\x03）で中断
 *  - エスケープシーケンス（矢印キー・貼り付けの開始/終了の印など）とその他の制御文字は無視する
 */
export class HiddenLineBuffer {
  private chars: string[] = [];
  private escape: "none" | "start" | "csi" = "none";

  feed(chunk: string): HiddenInputState {
    for (const ch of chunk) {
      if (this.escape === "start") {
        this.escape = ch === "[" ? "csi" : "none";
        continue;
      }
      if (this.escape === "csi") {
        if (ch >= "@" && ch <= "~") this.escape = "none";
        continue;
      }
      if (ch === "\r" || ch === "\n") return { status: "done", value: this.chars.join("") };
      if (ch === "\u0003") return { status: "interrupt" };
      if (ch === "\u007f" || ch === "\b") this.chars.pop();
      else if (ch === "\u001b") this.escape = "start";
      else if (ch >= " ") this.chars.push(ch);
    }
    return { status: "pending" };
  }
}
