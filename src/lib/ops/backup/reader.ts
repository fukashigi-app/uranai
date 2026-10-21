/**
 * Firestore の「読み取り専用」REST クライアント（バックアップ用）。
 *
 * - 使うのは読み取りの API だけ（コレクション一覧・ドキュメント一覧・件数の集計）。
 *   書き込み・削除・更新の API は実装していない。さらに request() で URL と HTTP メソッドを許可リストで確認し、
 *   それ以外を送ろうとしたら例外にする（コードの誤りがあっても書き込みが送られない）。
 * - 値は Firestore の REST 形式（型付き JSON: integerValue / doubleValue / timestampValue / geoPointValue /
 *   referenceValue / bytesValue / mapValue / arrayValue / nullValue …）のまま扱い、型情報を失わない。
 * - 認証は呼び出し側から getToken で渡す（本番: サービスアカウントのアクセストークン、Emulator: "owner"）。
 */

export type FirestoreValue = Record<string, unknown>;
export type RestDocument = {
  name: string;
  fields?: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
};

export type ReaderOptions = {
  /** 例: https://firestore.googleapis.com または http://127.0.0.1:8080 */
  baseUrl: string;
  projectId: string;
  databaseId?: string;
  getToken: () => Promise<string>;
  /** すべての読み取りをこの時点の内容で行う（本番のみ。1時間以内の時刻） */
  readTime?: string;
  /** 1回の取得件数 */
  pageSize?: number;
  fetchImpl?: typeof fetch;
};

export class ReadOnlyViolationError extends Error {
  constructor(what: string) {
    super(`読み取り専用のクライアントで許可されていない操作です: ${what}`);
    this.name = "ReadOnlyViolationError";
  }
}

/** 許可する読み取り操作（メソッドと URL の末尾の形） */
export function isAllowedReadRequest(method: string, pathWithQuery: string): boolean {
  const path = pathWithQuery.split("?")[0];
  if (!path.startsWith("/v1/projects/")) return false;
  if (method === "GET") return !/:[a-zA-Z]+$/.test(path); // ドキュメント一覧（GET …/documents/<collection>）
  if (method === "POST") return /:(listCollectionIds|runAggregationQuery)$/.test(path);
  return false;
}

export class FirestoreReadOnlyReader {
  readonly root: string;
  private readonly o: Required<Omit<ReaderOptions, "readTime" | "fetchImpl">> & Pick<ReaderOptions, "readTime"> & { fetchImpl: typeof fetch };
  /** 送ったリクエストの数（読み取り回数の目安） */
  requests = 0;

  constructor(opts: ReaderOptions) {
    this.o = { databaseId: "(default)", pageSize: 300, fetchImpl: fetch, ...opts } as typeof this.o;
    this.root = `projects/${opts.projectId}/databases/${this.o.databaseId}/documents`;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!isAllowedReadRequest(method, path)) throw new ReadOnlyViolationError(`${method} ${path.replace(/documents\/.*/, "documents/…")}`);
    this.requests += 1;
    const res = await this.o.fetchImpl(`${this.o.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.o.getToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      // 応答本文にはドキュメントのパスが含まれることがあるため、状態コードと種類だけを返す
      let status = "";
      try {
        status = String((JSON.parse(text) as { error?: { status?: string } }).error?.status ?? "");
      } catch {
        status = "";
      }
      const err = new Error(`Firestore の読み取りに失敗しました（HTTP ${res.status}${status ? ` ${status}` : ""}）`);
      (err as Error & { httpStatus?: number }).httpStatus = res.status;
      throw err;
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private enc(path: string): string {
    // ドキュメントIDに使える文字（/ 以外）を URL として安全にする。区切りの / はそのまま
    return path.split("/").map((p) => encodeURIComponent(p)).join("/");
  }

  /** parentDoc（root からの相対パス。null ならトップレベル）の直下のコレクションID */
  async listCollectionIds(parentDoc: string | null): Promise<string[]> {
    const parent = parentDoc ? `${this.root}/${parentDoc}` : this.root;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.request<{ collectionIds?: string[]; nextPageToken?: string }>("POST", `/v1/${this.enc(parent)}:listCollectionIds`, {
        pageSize: this.o.pageSize,
        ...(pageToken ? { pageToken } : {}),
        ...(this.o.readTime ? { readTime: this.o.readTime } : {}),
      });
      ids.push(...(r.collectionIds ?? []));
      pageToken = r.nextPageToken || undefined;
    } while (pageToken);
    return ids.sort();
  }

  /**
   * collectionPath（root からの相対パス）のドキュメントを順に返す。
   * showMissing: フィールドの無い「親だけのドキュメント」（サブコレクションだけを持つ）も返す（name だけ）。
   */
  async *listDocuments(collectionPath: string): AsyncGenerator<RestDocument> {
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ pageSize: String(this.o.pageSize), showMissing: "true" });
      if (pageToken) q.set("pageToken", pageToken);
      if (this.o.readTime) q.set("readTime", this.o.readTime);
      const r = await this.request<{ documents?: RestDocument[]; nextPageToken?: string }>("GET", `/v1/${this.enc(`${this.root}/${collectionPath}`)}?${q}`);
      for (const d of r.documents ?? []) yield d;
      pageToken = r.nextPageToken || undefined;
    } while (pageToken);
  }

  /** トップレベルのコレクションの件数（見積もり用。1,000件ごとに1回の読み取り） */
  async countCollection(collectionId: string): Promise<number> {
    const r = await this.request<{ result?: { aggregateFields?: { n?: { integerValue?: string } } } }[]>("POST", `/v1/${this.enc(this.root)}:runAggregationQuery`, {
      structuredAggregationQuery: { structuredQuery: { from: [{ collectionId }] }, aggregations: [{ alias: "n", count: {} }] },
      ...(this.o.readTime ? { readTime: this.o.readTime } : {}),
    });
    return Number(r.find((x) => x.result)?.result?.aggregateFields?.n?.integerValue ?? 0);
  }

  /** root からの相対パス（例: users/abc） */
  relativePath(name: string): string {
    const i = name.indexOf("/documents/");
    return i >= 0 ? name.slice(i + "/documents/".length) : name;
  }
}
