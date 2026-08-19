import type { Config } from "./config.js";
import type { FetchImpl } from "./supabase.js";
import { sleep } from "./supabase.js";
import type {
  BatchResult,
  MulltiplyItem,
  MulltiplyResponse,
  StockUpdate,
} from "./types.js";

/** Thrown on 401/403 — the whole run must abort, every batch would fail. */
export class MulltiplyAuthError extends Error {
  constructor(status: number) {
    super(`Mulltiply rejected the API key (HTTP ${status}) — check MULLTIPLY_API_KEY`);
    this.name = "MulltiplyAuthError";
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 16000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Send one request with the shared retry policy: 429/5xx/network errors back
 * off exponentially (honouring Retry-After), 401/403 throws MulltiplyAuthError.
 * Returns the final response, or null when every attempt failed.
 */
async function sendWithRetry(
  url: string,
  method: "PUT" | "POST",
  body: string,
  cfg: Config,
  fetchImpl: FetchImpl,
): Promise<{ res: Response | null; attempts: number; lastError: string }> {
  const maxRetries = cfg.SYNC_MAX_RETRIES;
  let attempts = 0;
  let lastError = "";

  while (attempts <= maxRetries) {
    attempts++;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.MULLTIPLY_API_KEY,
        },
        body,
      });
    } catch (err) {
      lastError = `network error: ${String(err)}`;
      if (attempts <= maxRetries) {
        await sleep(backoffMs(attempts));
        continue;
      }
      break;
    }

    if (res.status === 401 || res.status === 403) {
      throw new MulltiplyAuthError(res.status);
    }

    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      if (attempts <= maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs(attempts);
        await sleep(waitMs);
        continue;
      }
      break;
    }

    return { res, attempts, lastError };
  }

  return { res: null, attempts, lastError };
}

/**
 * PUT one batch of items to Mulltiply's /v2/items/sync-data. Parses their
 * partial-failure envelope and maps row errors back to ISBNs (row index
 * first, itemName match as fallback — their docs don't state whether `row`
 * is 0- or 1-based).
 */
export async function pushBatch(
  items: MulltiplyItem[],
  batchNo: number,
  cfg: Config,
  fetchImpl: FetchImpl = fetch,
): Promise<BatchResult> {
  const url = `${cfg.MULLTIPLY_BASE_URL}/v2/items/sync-data`;
  const { res, attempts, lastError } = await sendWithRetry(
    url,
    "PUT",
    JSON.stringify(items),
    cfg,
    fetchImpl,
  );

  if (!res) {
    return {
      kind: "items",
      batchNo,
      itemCount: items.length,
      httpStatus: null,
      attempts,
      accepted: false,
      rowErrors: [],
      error: `gave up after ${attempts} attempts (${lastError})`,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      kind: "items",
      batchNo,
      itemCount: items.length,
      httpStatus: res.status,
      attempts,
      accepted: false,
      rowErrors: [],
      error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
    };
  }

  const parsed = (await res.json().catch(() => null)) as MulltiplyResponse | null;
  return {
    kind: "items",
    batchNo,
    itemCount: items.length,
    httpStatus: res.status,
    attempts,
    accepted: true,
    rowErrors: mapRowErrors(parsed, items),
  };
}

/**
 * POST one batch of stock-only updates to Mulltiply's inventory API
 * (/v2/godowns/thirdparty-stock-sync). Each entry is addressed by the
 * selling-unit syncId with their required prefix. Rejected rows come back in
 * `nonProcessablesStocks` and are surfaced as rowErrors so the caller can
 * fall back to a full item-sync for those books.
 */
export async function pushStockBatch(
  updates: StockUpdate[],
  batchNo: number,
  cfg: Config,
  fetchImpl: FetchImpl = fetch,
): Promise<BatchResult> {
  const url = `${cfg.MULLTIPLY_BASE_URL}/v2/godowns/thirdparty-stock-sync`;
  const body = JSON.stringify(
    updates.map((u) => ({
      syncId: `${cfg.SYNC_STOCK_SYNCID_PREFIX}${u.isbn}`,
      inventoryQuantity: u.quantity,
    })),
  );
  const { res, attempts, lastError } = await sendWithRetry(
    url,
    "POST",
    body,
    cfg,
    fetchImpl,
  );

  if (!res) {
    return {
      kind: "stock",
      batchNo,
      itemCount: updates.length,
      httpStatus: null,
      attempts,
      accepted: false,
      rowErrors: [],
      error: `gave up after ${attempts} attempts (${lastError})`,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      kind: "stock",
      batchNo,
      itemCount: updates.length,
      httpStatus: res.status,
      attempts,
      accepted: false,
      rowErrors: [],
      error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
    };
  }

  // lenient parsing — their documented shape is
  // { data: { validRowsCount, nonProcessablesStocks: [{syncId, reason?}] } }
  const parsed = (await res.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  const data = (parsed?.["data"] ?? parsed) as Record<string, unknown> | null;
  const raw = data?.["nonProcessablesStocks"];
  const rowErrors: BatchResult["rowErrors"] = Array.isArray(raw)
    ? raw.map((e) => {
        const entry = e as Record<string, unknown>;
        const sid = String(entry?.["syncId"] ?? "");
        const reason =
          entry?.["reason"] ?? entry?.["message"] ?? entry?.["error"] ?? JSON.stringify(entry);
        return {
          isbn: sid.startsWith(cfg.SYNC_STOCK_SYNCID_PREFIX)
            ? sid.slice(cfg.SYNC_STOCK_SYNCID_PREFIX.length)
            : sid,
          itemName: "",
          errors: [String(reason)],
        };
      })
    : [];

  return {
    kind: "stock",
    batchNo,
    itemCount: updates.length,
    httpStatus: res.status,
    attempts,
    accepted: true,
    rowErrors,
  };
}

function mapRowErrors(
  response: MulltiplyResponse | null,
  items: MulltiplyItem[],
): BatchResult["rowErrors"] {
  const errors = response?.data?.errors;
  if (!errors?.length) return [];

  return errors.map((e) => {
    // try the index as given, then off-by-one, then itemName match
    const byIndex =
      items[e.row] && items[e.row]!.itemName === e.itemName
        ? items[e.row]
        : items[e.row - 1] && items[e.row - 1]!.itemName === e.itemName
          ? items[e.row - 1]
          : items.find((i) => i.itemName === e.itemName);
    return {
      isbn: byIndex?.syncId ?? "",
      itemName: e.itemName,
      errors: e.errors,
    };
  });
}
