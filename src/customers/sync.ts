import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { MulltiplyAuthError } from "../mulltiply-client.js";
import { readState, writeState } from "../state.js";
import type { FetchImpl } from "../supabase.js";
import { sleep } from "../supabase.js";
import { pushRetailerBatch } from "./client.js";
import { fetchCustomers } from "./feed.js";
import { customerToRetailer } from "./transform.js";
import type {
  CustomerBatchResult,
  CustomerRunMode,
  CustomerRunReport,
  CustomerRunStatus,
  MulltiplyRetailer,
} from "./types.js";

export interface CustomerSyncOptions {
  mode: CustomerRunMode;
  dryRun?: boolean;
  limit?: number;
  customerCode?: string;
  /** Explicit incremental watermark override (ISO timestamp). */
  since?: string;
  runId?: string;
}

export interface CustomerSyncDeps {
  fetchCustomersImpl?: typeof fetchCustomers;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}

export interface CustomerInFlightInfo {
  runId: string;
  mode: CustomerRunMode;
  startedAt: string;
  batchesDone: number;
  batchesTotal: number | null;
}

let inFlight: CustomerInFlightInfo | null = null;
export function getCustomerInFlight(): CustomerInFlightInfo | null {
  return inFlight;
}

export class CustomerSyncBusyError extends Error {
  constructor(runId: string) {
    super(`A customer sync run is already in progress (${runId})`);
    this.name = "CustomerSyncBusyError";
  }
}

/** Overlap subtracted from the watermark so clock skew can't drop rows. */
const INCREMENTAL_OVERLAP_MS = 60_000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function runsDir(dataDir: string): string {
  return join(dataDir, "customer-runs");
}

export async function writeCustomerReport(dataDir: string, report: CustomerRunReport): Promise<string> {
  const dir = runsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `run-${report.runId}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

export async function readLatestCustomerReport(dataDir: string): Promise<CustomerRunReport | null> {
  try {
    const files = (await readdir(runsDir(dataDir)))
      .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
      .sort();
    const latest = files.at(-1);
    if (!latest) return null;
    return JSON.parse(await readFile(join(runsDir(dataDir), latest), "utf8")) as CustomerRunReport;
  } catch {
    return null;
  }
}

export function formatCustomerSummary(report: CustomerRunReport): string {
  const t = report.totals;
  const lines = [
    `Customer run ${report.runId} (${report.mode}${report.dryRun ? ", DRY RUN" : ""}) — ${report.status}`,
    `  Duration : ${(report.durationMs / 1000).toFixed(1)}s`,
    `  Fetched  : ${t.fetched}`,
    `  Skipped  : ${t.skipped}`,
    `  Sent     : ${t.sent} (${report.batches.length} batches, ${t.accepted} accepted)`,
    `  RowErrors: ${t.rowErrors}`,
  ];
  const warnings = Object.entries(report.warningCounts);
  if (warnings.length > 0) lines.push(`  Warnings : ${warnings.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (report.fatalError) lines.push(`  FATAL    : ${report.fatalError}`);
  return lines.join("\n");
}

/**
 * Push ERP customers to Mulltiply. Mirrors runSync for items: the ERP view
 * decides eligibility and the phone; this pages it, maps rows, POSTs batches,
 * and advances a customer watermark (customer.lastSyncAt) on every fully
 * successful run — including a run that found nothing to send. A missing
 * watermark on an incremental means a bounded look-back, never everything.
 */
export async function runCustomerSync(
  cfg: Config,
  opts: CustomerSyncOptions,
  deps: CustomerSyncDeps = {},
): Promise<CustomerRunReport> {
  if (inFlight) throw new CustomerSyncBusyError(inFlight.runId);

  const log = deps.log ?? ((msg: string) => console.log(msg));
  const fetchCustomersImpl = deps.fetchCustomersImpl ?? fetchCustomers;
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && !cfg.MULLTIPLY_API_KEY) {
    throw new Error("MULLTIPLY_API_KEY is not set — use --dry-run or configure the key");
  }

  const startedAt = new Date();
  const runId = opts.runId ?? startedAt.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  inFlight = { runId, mode: opts.mode, startedAt: startedAt.toISOString(), batchesDone: 0, batchesTotal: null };

  const report: CustomerRunReport = {
    runId,
    mode: opts.mode,
    dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    status: "completed",
    totals: { fetched: 0, skipped: 0, sent: 0, accepted: 0, rowErrors: 0 },
    warningCounts: {},
    skipped: [],
    batches: [],
  };

  try {
    let since: string | undefined = opts.since;
    if (opts.mode === "incremental" && !since && !opts.customerCode) {
      const state = await readState(cfg.DATA_DIR);
      const last = state.customer?.lastSyncAt;
      if (last) {
        since = new Date(new Date(last).getTime() - INCREMENTAL_OVERLAP_MS).toISOString();
      } else {
        since = new Date(startedAt.getTime() - cfg.SYNC_INCR_WINDOW_MINUTES * 60_000).toISOString();
        log(`No customer watermark — using bounded ${cfg.SYNC_INCR_WINDOW_MINUTES}-minute window (since ${since}).`);
      }
    }

    log(`Fetching customers (${since ? `since=${since}` : "all eligible"}${opts.customerCode ? `, code=${opts.customerCode}` : ""}${opts.limit ? `, limit=${opts.limit}` : ""})…`);
    const rows = await fetchCustomersImpl(cfg, { since, limit: opts.limit, customerCode: opts.customerCode });
    report.totals.fetched = rows.length;

    const retailers: MulltiplyRetailer[] = [];
    for (const row of rows) {
      const result = customerToRetailer(row, cfg);
      if (result.status === "skip") {
        report.skipped.push({ customerCode: result.customerCode, customerName: result.customerName, reason: result.reason });
        continue;
      }
      for (const w of result.warnings) report.warningCounts[w] = (report.warningCounts[w] ?? 0) + 1;
      retailers.push(result.retailer);
    }
    report.totals.skipped = report.skipped.length;
    log(`Transformed ${retailers.length} retailers (${report.totals.skipped} skipped).`);

    const batches = chunk(retailers, cfg.CUSTOMER_BATCH_SIZE);
    inFlight.batchesTotal = batches.length;

    if (dryRun) {
      log(`DRY RUN — would POST ${retailers.length} retailers in ${batches.length} batches.`);
    } else {
      for (const [i, batch] of batches.entries()) {
        const result: CustomerBatchResult = await pushRetailerBatch(batch, i + 1, cfg, deps.fetchImpl);
        report.batches.push(result);
        report.totals.sent += batch.length;
        if (result.accepted) report.totals.accepted += 1;
        report.totals.rowErrors += result.rowErrors.length;
        inFlight.batchesDone = i + 1;
        log(`  batch ${i + 1}/${batches.length}: ${batch.length} rows → ${result.accepted ? "accepted" : `FAILED (${result.error})`}${result.rowErrors.length ? `, ${result.rowErrors.length} row errors` : ""}`);
        if (i + 1 < batches.length && cfg.SYNC_BATCH_DELAY_MS > 0) await sleep(cfg.SYNC_BATCH_DELAY_MS);
      }
    }

    report.status = deriveStatus(report);

    const fullySuccessful = report.status !== "failed" && report.batches.every((b) => b.accepted);
    const state = await readState(cfg.DATA_DIR);
    const customer = state.customer ?? { lastSyncAt: null, lastFullSyncAt: null, lastRun: null };
    if (!dryRun && !opts.customerCode && !opts.limit && fullySuccessful) {
      customer.lastSyncAt = report.startedAt;
      if (opts.mode === "full") customer.lastFullSyncAt = report.startedAt;
    }
    if (!dryRun) {
      customer.lastRun = {
        runId: report.runId,
        mode: report.mode,
        status: report.status,
        finishedAt: new Date().toISOString(),
        totals: report.totals,
      };
      state.customer = customer;
      await writeState(cfg.DATA_DIR, state);
    }
  } catch (err) {
    report.fatalError = err instanceof MulltiplyAuthError ? err.message : String(err);
    report.status = "failed";
  } finally {
    const finished = new Date();
    report.finishedAt = finished.toISOString();
    report.durationMs = finished.getTime() - startedAt.getTime();
    inFlight = null;
    try {
      const file = await writeCustomerReport(cfg.DATA_DIR, report);
      log(formatCustomerSummary(report));
      log(`Report: ${file}`);
    } catch (reportErr) {
      log(`Failed to write customer run report: ${String(reportErr)}`);
    }
  }

  return report;
}

function deriveStatus(report: CustomerRunReport): CustomerRunStatus {
  if (report.fatalError) return "failed";
  const failedBatches = report.batches.filter((b) => !b.accepted).length;
  if (failedBatches > 0 || report.totals.rowErrors > 0) return "completed_with_errors";
  return "completed";
}
