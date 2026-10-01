import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { Card, PageHeader, StatusBadge, Table } from "@/components/console/shell";
import { QrPanel } from "@/components/console/qr-panel";
import { BankForm } from "@/components/console/store-forms";
import { ActionButton, NewStoreUserForm, StoreAdminProfileForm } from "@/components/console/admin-forms";
import { requireOperator } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { auditLogs, storeUsers, stores, users } from "@/lib/db/schema";
import { listTransactions, monthlySeries } from "@/lib/services/reports";
import { listSettlements } from "@/lib/services/settlements";
import { readBankInfoMasked } from "@/lib/services/stores";
import { qrSvgDataUrl, storeUrl } from "@/lib/services/qr";
import { FORTUNE_CATALOG } from "@/lib/fortune/catalog";
import { formatDateJa, formatDateTimeJa, formatYearMonthJa } from "@/lib/time";
import { formatYen } from "@/lib/money";
import {
  createStoreUserAction,
  reissueQrAction,
  resetStoreUserPasswordAction,
  revealBankAction,
  setStoreStatusAction,
  toggleStoreUserAction,
  updateStoreAction,
  updateStoreBankAdminAction,
} from "../../../actions";

export const metadata = { title: "店舗詳細" };

const AUDIT_LABEL: Record<string, string> = {
  "store.create": "店舗作成",
  "store.profile.update": "店舗情報変更",
  "store.bank.update": "振込先変更",
  "store.bank.reveal": "口座番号の閲覧",
  "store.suspend": "店舗停止",
  "store.resume": "店舗再開",
  "store.qr.reissue": "QR再発行",
  "store.share.update": "配分率変更",
  "store.user.create": "アカウント作成",
  "user.password.set": "パスワード変更",
  "user.enable": "アカウント有効化",
  "user.disable": "アカウント無効化",
  "settlement.status": "精算ステータス変更",
};

export default async function AdminStoreDetail(props: PageProps<"/admin/stores/[id]">) {
  await requireOperator();
  const { id } = await props.params;
  const sp = await props.searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [store] = await db().select().from(stores).where(eq(stores.id, id));
  if (!store) notFound();

  const [monthly, txs, settlementRows, staff, audits, qr] = await Promise.all([
    monthlySeries(12, id),
    listTransactions({ storeId: id, page: 1, perPage: 15 }),
    listSettlements({ storeId: id, limit: 24 }),
    db()
      .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive, lastLoginAt: users.lastLoginAt })
      .from(storeUsers)
      .innerJoin(users, eq(users.id, storeUsers.userId))
      .where(eq(storeUsers.storeId, id)),
    db().select().from(auditLogs).where(eq(auditLogs.storeId, id)).orderBy(desc(auditLogs.createdAt)).limit(30),
    qrSvgDataUrl(store.storeCode),
  ]);
  const bank = readBankInfoMasked(store);
  const suspended = store.status === "SUSPENDED";

  return (
    <>
      <p className="mb-2 text-[12px]">
        <Link href="/admin/stores" className="text-ink-muted underline underline-offset-4">
          ← 店舗一覧
        </Link>
      </p>
      <PageHeader
        title={store.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={store.status} /> 店舗コード <span className="font-mono">{store.storeCode}</span> ／ 登録 {formatDateJa(store.createdAt)}
          </span>
        }
        actions={
          <>
            {suspended ? (
              <ActionButton action={setStoreStatusAction.bind(null, id, "ACTIVE")} label="店舗を再開" variant="gold" />
            ) : (
              <ActionButton action={setStoreStatusAction.bind(null, id, "SUSPENDED")} label="店舗を停止" variant="danger" confirmMessage="この店舗を停止しますか？停止中はQRから決済できなくなります。" />
            )}
          </>
        }
      />
      {sp.notice === "dup-user" ? <p className="mb-4 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">店舗は作成しましたが、ログインメールが既に使われていたためアカウントは作成されませんでした。</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="店舗情報">
          <StoreAdminProfileForm
            action={updateStoreAction.bind(null, id)}
            values={{ name: store.name, contactName: store.contactName, postalCode: store.postalCode, address: store.address, phone: store.phone, email: store.email }}
            sharePercent={store.storeShareBps / 100}
          />
        </Card>
        <Card title="振込情報">
          {bank ? (
            <div className="mb-4 rounded-xl border border-white/10 bg-night-950/40 p-3 text-[13px]">
              <p>
                {bank.bankName}（{bank.bankCode}） {bank.branchName}（{bank.branchCode}）
              </p>
              <p className="mt-1">
                {bank.accountType} {bank.accountNumber} ／ {bank.accountHolder}
              </p>
              <p className="mt-1 text-[11px] text-ink-faint">最終更新 {formatDateTimeJa(store.bankUpdatedAt)}</p>
              <div className="mt-3">
                <ActionButton action={revealBankAction.bind(null, id)} label="口座番号を全桁表示（記録されます）" />
              </div>
            </div>
          ) : (
            <p className="mb-4 text-[13px] text-gold-200">振込先が未登録です。</p>
          )}
          <details>
            <summary className="cursor-pointer text-[13px] text-ink-muted">振込先を編集</summary>
            <div className="mt-3">
              <BankForm action={updateStoreBankAdminAction.bind(null, id)} defaults={bank} requirePassword={false} />
            </div>
          </details>
        </Card>
      </div>

      <div className="mt-4">
        <h2 className="mb-2 font-serif text-base font-bold">店舗QR</h2>
        <QrPanel dataUrl={qr} url={storeUrl(store.storeCode)} downloadHref={`/api/store/qr?storeId=${id}`} printHref={`/admin/stores/${id}/print`} />
        <div className="mt-3">
          <ActionButton action={reissueQrAction.bind(null, id)} label="QRを再発行する" variant="danger" confirmMessage="QRを再発行すると、現在設置されているQRコードは使えなくなります。よろしいですか？" />
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="月別集計">
          <Table head={["年月", "件数", "売上", "店舗報酬", "運営売上"]}>
            {monthly.map((m) => (
              <tr key={m.yearMonth}>
                <td>{formatYearMonthJa(m.yearMonth)}</td>
                <td className="tabular-nums">{m.count}件</td>
                <td className="tabular-nums">{formatYen(m.gross)}</td>
                <td className="tabular-nums text-gold-200">{formatYen(m.storeShare)}</td>
                <td className="tabular-nums">{formatYen(m.operatorShare)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="支払い履歴（精算）" actions={<Link href="/admin/settlements" className="text-[12px] text-ink-muted underline underline-offset-4">月次精算へ</Link>}>
          <Table head={["対象月", "件数", "店舗報酬", "状況", "支払日", "メモ"]} empty={settlementRows.length === 0}>
            {settlementRows.map(({ s }) => (
              <tr key={s.id}>
                <td>{formatYearMonthJa(s.yearMonth)}</td>
                <td className="tabular-nums">{s.transactionCount}件</td>
                <td className="tabular-nums text-gold-200">{formatYen(s.storeShare)}</td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className="whitespace-nowrap">{s.paidAt ? formatDateJa(s.paidAt) : "—"}</td>
                <td className="max-w-40 truncate text-ink-muted">{s.note || "—"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="利用・売上履歴（最新15件）" className="mt-4" actions={<Link href={`/admin/transactions?storeId=${id}`} className="text-[12px] text-ink-muted underline underline-offset-4">すべて見る</Link>}>
        <Table head={["日時", "占い", "金額", "店舗報酬", "手数料", "決済", "占い"]} empty={txs.rows.length === 0}>
          {txs.rows.map((t) => (
            <tr key={t.id}>
              <td className="whitespace-nowrap tabular-nums">{formatDateTimeJa(t.paidAt)}</td>
              <td>{FORTUNE_CATALOG[t.fortuneType].short}</td>
              <td className="tabular-nums">{formatYen(t.amount)}</td>
              <td className="tabular-nums text-gold-200">{formatYen(t.storeShare)}</td>
              <td className="tabular-nums">{formatYen(t.paymentFee)}</td>
              <td>
                <StatusBadge status={t.paymentStatus} />
              </td>
              <td>
                <StatusBadge status={t.fortuneStatus} />
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="店舗アカウント">
          <ul className="divide-y divide-white/5">
            {staff.map((u) => (
              <li key={u.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-[13px]">
                <div>
                  <p className="font-bold">
                    {u.name} {u.isActive ? null : <StatusBadge status="SUSPENDED" />}
                  </p>
                  <p className="text-ink-muted">{u.email}</p>
                  <p className="text-[11px] text-ink-faint">最終ログイン {formatDateTimeJa(u.lastLoginAt)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ActionButton action={resetStoreUserPasswordAction.bind(null, id, u.id)} label="パスワード再発行" confirmMessage="一時パスワードを発行します。現在のパスワードは使えなくなります。" />
                  <ActionButton action={toggleStoreUserAction.bind(null, id, u.id, !u.isActive)} label={u.isActive ? "無効化" : "有効化"} variant={u.isActive ? "danger" : "ghost"} />
                </div>
              </li>
            ))}
            {staff.length === 0 ? <li className="py-3 text-[13px] text-ink-faint">アカウントがありません</li> : null}
          </ul>
          <div className="mt-3 border-t border-white/10 pt-3">
            <NewStoreUserForm action={createStoreUserAction.bind(null, id)} />
          </div>
        </Card>
        <Card title="変更履歴">
          <ul className="max-h-[420px] divide-y divide-white/5 overflow-y-auto text-[12px]">
            {audits.map((a) => (
              <li key={a.id} className="py-2.5">
                <p>
                  <span className="text-ink">{AUDIT_LABEL[a.action] ?? a.action}</span>
                  <span className="ml-2 text-ink-faint">
                    {formatDateTimeJa(a.createdAt)} ／ {a.actorRole === "OPERATOR" ? "運営" : a.actorRole === "STORE" ? "店舗" : "システム"}
                  </span>
                </p>
                {a.after && typeof a.after === "object" && Object.keys(a.after).length ? (
                  <p className="mt-0.5 break-all text-ink-faint">
                    {Object.entries(a.after as Record<string, unknown>)
                      .map(([k, v]) => `${k}: ${String((a.before as Record<string, unknown> | null)?.[k] ?? "—")} → ${String(v)}`)
                      .join(" ／ ")}
                  </p>
                ) : null}
              </li>
            ))}
            {audits.length === 0 ? <li className="py-3 text-ink-faint">履歴はありません</li> : null}
          </ul>
        </Card>
      </div>
    </>
  );
}
