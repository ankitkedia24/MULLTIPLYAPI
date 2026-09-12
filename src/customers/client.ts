import type { Config } from "../config.js";
import { sendWithRetry } from "../mulltiply-client.js";
import type { FetchImpl } from "../supabase.js";
import type {
  CustomerBatchResult,
  MulltiplyRetailer,
  MulltiplyRetailerResponse,
} from "./types.js";

/**
 * POST one batch of retailers to Mulltiply's /v2/retailers/sync-data (same
 * retry/auth policy as the item pushes). Their partial-failure envelope lists
 * `nonProcessableRows: [{ row, errors }]` — capped at 20 by them, and the docs
 * do not say whether `row` is 0- or 1-based, so both readings are tried and
 * the syncId is left blank when neither fits.
 */
export async function pushRetailerBatch(
  retailers: MulltiplyRetailer[],
  batchNo: number,
  cfg: Config,
  fetchImpl: FetchImpl = fetch,
): Promise<CustomerBatchResult> {
  const url = `${cfg.MULLTIPLY_BASE_URL}/v2/retailers/sync-data`;
  const { res, attempts, lastError } = await sendWithRetry(
    url,
    "POST",
    JSON.stringify(retailers),
    cfg,
    fetchImpl,
  );

  if (!res) {
    return {
      batchNo,
      rowCount: retailers.length,
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
      batchNo,
      rowCount: retailers.length,
      httpStatus: res.status,
      attempts,
      accepted: false,
      rowErrors: [],
      error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
    };
  }

  const parsed = (await res.json().catch(() => null)) as
    | MulltiplyRetailerResponse
    | { data?: MulltiplyRetailerResponse }
    | null;
  const body: MulltiplyRetailerResponse | null =
    parsed && "data" in parsed && parsed.data ? parsed.data : (parsed as MulltiplyRetailerResponse | null);
  const raw = body?.nonProcessableRows;
  const rowErrors: CustomerBatchResult["rowErrors"] = Array.isArray(raw)
    ? raw.map((e) => {
        const idx = Number(e.row);
        const r = retailers[idx] ?? retailers[idx - 1];
        return {
          syncId: r?.syncId ?? "",
          customerName: r?.name ?? `row ${e.row}`,
          errors: Array.isArray(e.errors) ? e.errors.map(String) : [String(e.errors)],
        };
      })
    : [];

  return {
    batchNo,
    rowCount: retailers.length,
    httpStatus: res.status,
    attempts,
    accepted: true,
    rowErrors,
  };
}
