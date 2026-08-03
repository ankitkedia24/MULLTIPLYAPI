import type { Config } from "./config.js";
import type { BookRow } from "./types.js";

const BOOK_COLUMNS = [
  "isbn",
  "book_name",
  "short_description",
  "author_name",
  "publisher_name",
  "category",
  "sub_category",
  "subject",
  "class_name",
  "binding",
  "edition",
  "language",
  "cover_image_url",
  "sale_rate",
  "sale_retail_price",
  "sale_net_price",
  "sale_wholesale_price",
  "closing_stock",
  "is_active",
  "updated_at",
].join(",");

/** PostgREST hard-caps responses at 1000 rows, so page in 1000s. */
const PAGE_SIZE = 1000;

export interface FetchBooksOptions {
  /** ISO timestamp — only books with updated_at >= since (incremental sync). */
  since?: string;
  /** Fetch a single book by ISBN (smoke tests / preview). */
  isbn?: string;
  /** Stop after this many rows (preview / limited runs). */
  limit?: number;
  onProgress?: (fetched: number, total: number | null) => void;
}

export type FetchImpl = typeof fetch;

/** Fetch book rows from AMITCLOUD Supabase, read-only, paginated. */
export async function fetchBooks(
  cfg: Config,
  opts: FetchBooksOptions = {},
  fetchImpl: FetchImpl = fetch,
): Promise<BookRow[]> {
  const rows: BookRow[] = [];
  let offset = 0;
  let total: number | null = null;

  for (;;) {
    const pageLimit =
      opts.limit !== undefined
        ? Math.min(PAGE_SIZE, opts.limit - rows.length)
        : PAGE_SIZE;
    if (pageLimit <= 0) break;

    const params = new URLSearchParams({
      select: BOOK_COLUMNS,
      is_active: "eq.true",
      order: "isbn.asc",
      limit: String(pageLimit),
      offset: String(offset),
    });
    if (cfg.SYNC_BOOK_FILTER === "in_stock") {
      params.set("closing_stock", "gt.0");
    }
    if (opts.since) params.set("updated_at", `gte.${opts.since}`);
    if (opts.isbn) params.set("isbn", `eq.${opts.isbn}`);

    const url = `${cfg.SUPABASE_URL}/rest/v1/books?${params.toString()}`;
    const headers: Record<string, string> = {
      apikey: cfg.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY}`,
    };
    if (offset === 0) headers["Prefer"] = "count=exact";

    const res = await fetchWithRetry(url, { headers }, fetchImpl);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Supabase fetch failed: HTTP ${res.status} ${body.slice(0, 300)}`,
      );
    }

    if (offset === 0) {
      const range = res.headers.get("content-range");
      const match = range?.match(/\/(\d+)$/);
      total = match ? Number(match[1]) : null;
    }

    const page = (await res.json()) as BookRow[];
    rows.push(...page);
    opts.onProgress?.(rows.length, total);

    if (page.length < pageLimit) break;
    offset += page.length;
  }

  return rows;
}

/** Retry transient network/5xx errors when reading from Supabase. */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
  maxRetries = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`Supabase unreachable after ${maxRetries + 1} attempts: ${String(lastError)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
