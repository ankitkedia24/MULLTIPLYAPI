import type { Config } from "./config.js";
import type { FetchImpl } from "./supabase.js";
import { sleep } from "./supabase.js";
import type { BatchResult, MulltiplyItem, MulltiplyResponse } from "./types.js";

/** Thrown on 401/403 — the whole run must abort, every batch would fail. */
export class MulltiplyAuthError extends Error {
  constructor(status: number) {
    super(`Mulltiply rejected the API key (HTTP ${status}) — check MULLTIPLY_API_KEY`);
    this.name = "MulltiplyAuthError";
  }
}

/**
 * PUT one batch of items to Mulltiply's /v2/items/sync-data.
 * Retries 429/5xx/network errors with exponential backoff + jitter,
 * honoring Retry-After. Parses their partial-failure envelope and maps
 * row errors back to ISBNs (row index first, itemName match as fallback —
 * their docs don't state whether `row` is 0- or 1-based).
 */
export async function pushBatch(
  items: MulltiplyItem[],
  batchNo: number,
  cfg: Config,
  fetchImpl: FetchImpl = fetch,
): Promise<BatchResult> {
  const url = `${cfg.MULLTIPLY_BASE_URL}/v2/items/sync-data`;
  const body = JSON.stringify(items);
  const maxRetries = cfg.SYNC_MAX_RETRIES;

  let attempts = 0;
  let lastError = "";

  while (attempts <= maxRetries) {
    attempts++;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "PUT",
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

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
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
      batchNo,
      itemCount: items.length,
      httpStatus: res.status,
      attempts,
      accepted: true,
      rowErrors: mapRowErrors(parsed, items),
    };
  }

  return {
    batchNo,
    itemCount: items.length,
    httpStatus: null,
    attempts,
    accepted: false,
    rowErrors: [],
    error: `gave up after ${attempts} attempts (${lastError})`,
  };
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 16000);
  return base + Math.floor(Math.random() * 250);
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
