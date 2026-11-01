/**
 * 処理が終わっていない Stripe の通知の一覧（listUnfinishedWebhookEvents）のページ送りの E2E 検証（Firestore Emulator だけ）。
 * webhookEvents に記録を直接作り、全ページを読んで、対象の ID が欠けない・重複しないことを確かめる。
 *  0件・1件・100件・101件・500件超、Stripe と疑似決済の混在、新しい通知と古い通知の混在、同じ作成時刻のページの境界、
 *  ページ送りの途中の新しい通知・処理済みへの更新、以前の形の記録。
 * 本物の Firebase には一切接続しない（Firestore Emulator の demo- プロジェクトだけ）。Emulator は複合インデックスを要求しないので、
 * インデックス（firestore.indexes.json）の要否は本物の Firestore で確かめる必要がある。
 *
 *   firebase emulators:start --only firestore --project demo-uranai
 *   （別ターミナル）FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-uranai-webhook-pages DB_PROVIDER=firestore npm run e2e:stripe-webhook-pages
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { C, fsdb } from "@/lib/firestore/admin";
import { dataProvider } from "@/lib/data-provider";
import { listUnfinishedWebhookEvents, UNFINISHED_WEBHOOK_PAGE_MAX } from "@/lib/firestore/payments";

const step = (msg: string) => console.log(`  ✓ ${msg}`);
const col = () => fsdb().collection(C.webhookEvents);
const NOW = Date.now();
const MIN = 60_000;
const STALE = 10 * MIN;

type Seed = { id: string; provider?: string; createdAtMs?: number | null; lastAttemptAtMs?: number | null; processed?: boolean; noProcessedAt?: boolean; state?: string | null };
/** webhookEvents の記録を作る（beginWebhookEvent と同じ形。以前の形・項目の欠けた形も作れる） */
async function seed(rows: Seed[]) {
  for (let i = 0; i < rows.length; i += 400) {
    const b = fsdb().batch();
    for (const r of rows.slice(i, i + 400)) {
      const d: Record<string, unknown> = { provider: r.provider ?? "stripe", eventId: r.id, type: "charge.refunded" };
      if (!r.noProcessedAt) d.processedAt = r.processed ? Timestamp.fromMillis(NOW - MIN) : null;
      if (r.createdAtMs !== null) d.createdAt = Timestamp.fromMillis(r.createdAtMs ?? NOW - 60 * MIN);
      if (r.state !== null) d.state = r.state ?? (r.processed ? "PROCESSED" : "RECEIVED");
      if (r.lastAttemptAtMs !== null && r.lastAttemptAtMs !== undefined) d.lastAttemptAt = Timestamp.fromMillis(r.lastAttemptAtMs);
      b.set(col().doc(`${d.provider}_${r.id}`), d);
    }
    await b.commit();
  }
}
async function clear() {
  for (;;) {
    const snap = await col().limit(400).get();
    if (snap.empty) return;
    const b = fsdb().batch();
    for (const d of snap.docs) b.delete(d.ref);
    await b.commit();
  }
}
/** 全ページを読む。between はページを読むたびに呼ぶ（ページ送りの途中の変化の再現） */
async function readAll(opts: { pageSize?: number; staleMs?: number; between?: (pageNo: number) => Promise<void> } = {}) {
  const records: string[] = [];
  let scanned = 0;
  let pages = 0;
  let cursor: string | null = null;
  for (;;) {
    const p: Awaited<ReturnType<typeof listUnfinishedWebhookEvents>> = await listUnfinishedWebhookEvents({ staleMs: opts.staleMs ?? STALE, now: new Date(NOW), cursor, pageSize: opts.pageSize });
    pages++;
    scanned += p.scanned;
    records.push(...p.records.map((r) => r.eventId));
    assert.equal(p.hasMore, p.nextCursor !== null, "hasMore と nextCursor が食い違っています");
    if (p.nextCursor) {
      const raw = Buffer.from(p.nextCursor, "base64url").toString("utf8");
      assert.match(raw, /^\[\d+,\d+,"stripe_[A-Za-z0-9_]+"\]$/, "続きの位置に作成の時刻と文書の ID 以外が入っています");
    }
    if (!p.hasMore) return { records, scanned, pages };
    await opts.between?.(pages);
    cursor = p.nextCursor;
    assert.ok(pages < 1000, "ページが終わりません");
  }
}
const sameSet = (a: string[], b: string[], msg: string) => {
  assert.equal(new Set(a).size, a.length, `${msg}：重複があります`);
  assert.deepEqual([...a].sort(), [...b].sort(), msg);
};
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `evt_${prefix}_${String(i).padStart(4, "0")}`);

async function main() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  assert.match(host, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "FIRESTORE_EMULATOR_HOST（localhost の Emulator）が必要です");
  assert.match(process.env.FIREBASE_PROJECT_ID ?? "", /^demo-/, "FIREBASE_PROJECT_ID は demo- で始まる Emulator 用の ID にしてください");
  assert.equal(dataProvider(), "firestore");
  console.log(`Stripe webhook unfinished-list paging E2E (emulator ${host} / ${process.env.FIREBASE_PROJECT_ID})`);
  assert.equal(UNFINISHED_WEBHOOK_PAGE_MAX, 100);

  // 1. 0件
  await clear();
  let r = await readAll();
  assert.deepEqual([r.records, r.scanned, r.pages], [[], 0, 1]);
  step("0件：records は空・hasMore=false・nextCursor=null");

  // 2. 1件
  await seed([{ id: "evt_one" }]);
  r = await readAll();
  assert.deepEqual([r.records, r.scanned, r.pages], [["evt_one"], 1, 1]);
  step("1件：1ページで取得・hasMore=false");

  // 3. ちょうど100件（次のページが無いことを実際に確かめる）
  await clear();
  await seed(ids("h", 100).map((id, i) => ({ id, createdAtMs: NOW - 100 * MIN + i })));
  const first = await listUnfinishedWebhookEvents({ staleMs: STALE, now: new Date(NOW) });
  assert.deepEqual([first.records.length, first.scanned, first.hasMore, first.nextCursor], [100, 100, false, null], "ちょうど100件で次のページがあると判定しました");
  step("ちょうど100件：1ページ・hasMore=false（101件目を読んで確かめる）");

  // 4. 101件
  await seed([{ id: "evt_h_0100", createdAtMs: NOW - 100 * MIN + 100 }]);
  const p1 = await listUnfinishedWebhookEvents({ staleMs: STALE, now: new Date(NOW) });
  assert.deepEqual([p1.records.length, p1.hasMore, typeof p1.nextCursor], [100, true, "string"]);
  const p2 = await listUnfinishedWebhookEvents({ staleMs: STALE, now: new Date(NOW), cursor: p1.nextCursor });
  assert.deepEqual([p2.records.map((x) => x.eventId), p2.hasMore, p2.nextCursor], [["evt_h_0100"], false, null]);
  sameSet([...p1.records, ...p2.records].map((x) => x.eventId), ids("h", 101), "101件");
  step("101件：100件＋1件の2ページ。重複・欠けなし");

  // 5〜7. 500件超：Stripe と疑似決済、古い通知と新しい通知、処理済み、同じ作成時刻の記録を混在させる
  await clear();
  const staleIds = ids("old", 560); // 止まった通知（作成から1時間以上・最後の処理も古い）
  const freshIds = ids("new", 140); // 処理中かもしれない新しい通知（最後の処理が1分前）
  const rows: Seed[] = [
    // 同じ作成時刻を7件ずつ（ページの境界で同じ時刻をまたぐ）。文書の ID の並びを作成の順と逆にする
    ...staleIds.map((id, i) => ({ id, createdAtMs: NOW - 200 * MIN + Math.floor(i / 7) * 1000, lastAttemptAtMs: NOW - 120 * MIN })),
    ...freshIds.map((id, i) => ({ id, createdAtMs: NOW - 150 * MIN + i, lastAttemptAtMs: NOW - MIN })), // 古く作られたが最近再送された
    ...ids("mock", 130).map((id) => ({ id, provider: "mock", createdAtMs: NOW - 300 * MIN })), // 疑似決済（対象外）
    ...ids("done", 90).map((id) => ({ id, processed: true, createdAtMs: NOW - 250 * MIN })), // 処理済み（対象外）
    { id: "evt_zzzz_oldest_retryable", createdAtMs: NOW - 400 * MIN, lastAttemptAtMs: NOW - 300 * MIN, state: "RETRYABLE" }, // ID の並びは最後・作成は最初
  ];
  await seed(rows);
  r = await readAll();
  sameSet(r.records, [...staleIds, "evt_zzzz_oldest_retryable"], "500件超の全ページ");
  assert.equal(r.scanned, staleIds.length + freshIds.length + 1, "処理が終わっていない Stripe の記録の件数");
  assert.equal(r.pages, Math.ceil((staleIds.length + freshIds.length + 1) / 100));
  assert.ok(!r.records.some((x) => x.startsWith("evt_mock") || x.startsWith("evt_done") || x.startsWith("evt_new")));
  step(`500件超（止まった ${staleIds.length + 1} 件・処理中かもしれない ${freshIds.length} 件・疑似決済 130 件・処理済み 90 件）：${r.pages} ページで止まった通知をすべて取得。疑似決済・処理済み・新しい通知は含まない。ID の並びが最後の最も古い通知も含む`);

  // 8. ページの境界：同じ作成時刻が境界をまたいでも、重複・欠けなし（小さいページ）
  for (const size of [1, 3, 7, 50]) {
    const b = await readAll({ pageSize: size });
    sameSet(b.records, [...staleIds, "evt_zzzz_oldest_retryable"], `ページの大きさ ${size}`);
  }
  step("ページの境界（大きさ 1・3・7・50。同じ作成時刻の7件がページをまたぐ）：重複・欠けなし");

  // 9. ページ送りの途中に新しい通知が届く：既存の対象は欠けない。新しい通知は後のページに入る（止まったものとしては扱わない）
  const added: string[] = [];
  r = await readAll({
    between: async (n) => {
      if (n > 3) return;
      const id = `evt_added_${n}`;
      added.push(id);
      await seed([{ id, createdAtMs: Date.now(), lastAttemptAtMs: Date.now() }]);
    },
  });
  sameSet(r.records, [...staleIds, "evt_zzzz_oldest_retryable"], "途中で新しい通知が届いた場合");
  assert.equal(r.scanned, staleIds.length + freshIds.length + 1 + added.length, "途中で届いた新しい通知が後のページに入っていません");
  step("ページ送りの途中の新しい通知：既存の対象は欠けず、新しい通知は後のページに入る（処理中かもしれないので対象外）");

  // 10. ページ送りの途中に処理済みになる：読んだ記録・まだ読んでいない記録の一部が処理済みになっても、残りは欠けない
  const doneLater = new Set<string>();
  r = await readAll({
    between: async (n) => {
      if (n !== 2) return;
      const b = fsdb().batch();
      // 既に読んだ範囲から10件、まだ読んでいない範囲から20件を処理済みにする
      for (const id of [...staleIds.slice(0, 10), ...staleIds.slice(400, 420)]) {
        doneLater.add(id);
        b.update(col().doc(`stripe_${id}`), { processedAt: Timestamp.now(), state: "PROCESSED" });
      }
      await b.commit();
    },
  });
  const expected = [...staleIds.filter((id) => !staleIds.slice(400, 420).includes(id)), "evt_zzzz_oldest_retryable"];
  sameSet(r.records, expected, "途中で処理済みになった場合");
  step("ページ送りの途中に処理済み（読んだ10件・まだ読んでいない20件）：まだ読んでいない処理済みは含まず、ほかは欠けない（ページ送りは破綻しない）");

  // 11. 以前の形の記録
  await clear();
  await seed([
    { id: "evt_legacy_stale", createdAtMs: NOW - 60 * MIN, state: null }, // state・lastAttemptAt なし：作成の時刻で判定
    { id: "evt_legacy_recent", createdAtMs: NOW - MIN, state: null },
    { id: "evt_legacy_no_processed_field", createdAtMs: NOW - 60 * MIN, noProcessedAt: true, state: null }, // processedAt の項目なし：対象外（仕様）
    { id: "evt_legacy_no_created", createdAtMs: null, state: null }, // createdAt なし：対象外（仕様）
  ]);
  r = await readAll();
  sameSet(r.records, ["evt_legacy_stale"], "以前の形の記録");
  assert.equal(r.scanned, 2, "processedAt・createdAt の項目が無い記録を読みました（仕様では対象外）");
  const legacy = (await listUnfinishedWebhookEvents({ staleMs: STALE, now: new Date(NOW) })).records[0];
  assert.deepEqual([legacy.state, legacy.attempts, legacy.lastAttemptAt], ["RECEIVED", null, null]);
  step("以前の形：state・lastAttemptAt が無い記録は作成の時刻で判定（RECEIVED）。processedAt・createdAt の項目が無い記録は対象外（仕様どおり）");

  // 12. 形の正しくない続きの位置は例外（推測で位置を決めない）
  await assert.rejects(listUnfinishedWebhookEvents({ staleMs: STALE, cursor: "broken" }), /invalid webhook event cursor/);
  step("形の正しくない続きの位置：例外（最初から読み直す）");

  await clear();
  console.log("\nSTRIPE WEBHOOK PAGES E2E PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nSTRIPE WEBHOOK PAGES E2E FAILED:", e);
    process.exit(1);
  });
