import type { Config } from "./config.js";
import { MulltiplyAuthError, pushBatch } from "./mulltiply-client.js";
import { formatSummary, writeReport } from "./report.js";
import { readState, writeState } from "./state.js";
import type { FetchImpl } from "./supabase.js";
import { fetchBooks, sleep } from "./supabase.js";
import { bookToItem } from "./transform.js";
import type {
  BatchResult,
  MulltiplyItem,
  RunMode,
  RunReport,
  RunStatus,
} from "./types.js";
import { validateItems } from "./validate.js";

export interface SyncOptions {
  mode: RunMode;
  dryRun?: boolean;
  limit?: number;
  isbn?: string;
  /** Explicit incremental watermark override (ISO timestamp). */
  since?: string;
  runId?: string;
}

export interface SyncDeps {
  /** Injectable for tests: replaces the Supabase fetch. */
  fetchBooksImpl?: typeof fetchBooks;
  /** Injectable for tests: fetch used for Mulltiply pushes. */
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}

export interface InFlightInfo {
  runId: string;
  mode: RunMode;
  startedAt: string;
  phase: "fetching" | "transforming" | "pushing";
  batchesDone: number;
  batchesTotal: number | null;
}

let inFlight: InFlightInfo | null = null;

export function getInFlight(): InFlightInfo | null {
  return inFlight;
}

export class SyncBusyError extends Error {
  constructor(runId: string) {
    super(`A sync run is already in progress (${runId})`);
    this.name = "SyncBusyError";
  }
}

/** Overlap subtracted from the watermark so clock skew can't drop rows. */
const INCREMENTAL_OVERLAP_MS = 60_000;

export async function runSync(
  cfg: Config,
  opts: SyncOptions,
  deps: SyncDeps = {},
): Promise<RunReport> {
  if (inFlight) throw new SyncBusyError(inFlight.runId);

  const log = deps.log ?? ((msg: string) => console.log(msg));
  const fetchBooksImpl = deps.fetchBooksImpl ?? fetchBooks;
  const dryRun = opts.dryRun ?? false;

  if (!dryRun && !cfg.MULLTIPLY_API_KEY) {
    throw new Error("MULLTIPLY_API_KEY is not set — use --dry-run or configure the key");
  }

  const startedAt = new Date();
  const runId =
    opts.runId ?? startedAt.toISOString().replace(/[:.]/g, "-").replace("Z", "");

  inFlight = {
    runId,
    mode: opts.mode,
    startedAt: startedAt.toISOString(),
    phase: "fetching",
    batchesDone: 0,
    batchesTotal: null,
  };

  const report: RunReport = {
    runId,
    mode: opts.mode,
    dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    status: "completed",
    totals: { fetched: 0, skipped: 0, invalid: 0, sent: 0, accepted: 0, rowErrors: 0 },
    warningCounts: {},
    skipped: [],
    invalid: [],
    batches: [],
  };

  try {
    // resolve the incremental watermark
    let since: string | undefined = opts.since;
    if (opts.mode === "incremental" && !since && !opts.isbn) {
      const state = await readState(cfg.DATA_DIR);
      if (state.lastSyncAt) {
        since = new Date(
          new Date(state.lastSyncAt).getTime() - INCREMENTAL_OVERLAP_MS,
        ).toISOString();
      } else {
        // never fall back to a full fetch — on ephemeral hosting the state
        // file can vanish (deploys/restarts), and refetching everything every
        // 30 minutes floods the partner's ingestion queue. A bounded window
        // covers the gap; the nightly full sync reconciles anything older.
        since = new Date(
          startedAt.getTime() - cfg.SYNC_INCR_WINDOW_MINUTES * 60_000,
        ).toISOString();
        log(
          `No previous sync watermark — using bounded ${cfg.SYNC_INCR_WINDOW_MINUTES}-minute window (since ${since}).`,
        );
      }
    }

    log(
      `Fetching books (filter=${cfg.SYNC_BOOK_FILTER}${since ? `, since=${since}` : ""}${opts.isbn ? `, isbn=${opts.isbn}` : ""}${opts.limit ? `, limit=${opts.limit}` : ""})…`,
    );
    const rows = await fetchBooksImpl(
      cfg,
      {
        since,
        isbn: opts.isbn,
        limit: opts.limit,
        onProgress: (fetched, total) =>
          log(`  fetched ${fetched}${total !== null ? `/${total}` : ""} rows`),
      },
      deps.fetchImpl ?? fetch,
    );
    report.totals.fetched = rows.length;

    inFlight.phase = "transforming";
    const items: MulltiplyItem[] = [];
    for (const row of rows) {
      const result = bookToItem(row, cfg);
      if (result.status === "skip") {
        report.skipped.push({
          isbn: result.isbn,
          bookName: result.bookName,
          reason: result.reason,
        });
        continue;
      }
      for (const w of result.warnings) {
        report.warningCounts[w] = (report.warningCounts[w] ?? 0) + 1;
      }
      items.push(result.item);
    }
    report.totals.skipped = report.skipped.length;

    const { valid, invalid } = validateItems(items);
    report.invalid = invalid;
    report.totals.invalid = invalid.length;
    log(
      `Transformed ${items.length} items (${report.totals.skipped} skipped, ${invalid.length} invalid).`,
    );

    if (dryRun) {
      log("Dry run — nothing sent to Mulltiply.");
    } else if (valid.length === 0) {
      log("Nothing to send.");
    } else {
      const batches: MulltiplyItem[][] = [];
      for (let i = 0; i < valid.length; i += cfg.SYNC_BATCH_SIZE) {
        batches.push(valid.slice(i, i + cfg.SYNC_BATCH_SIZE));
      }
      inFlight.phase = "pushing";
      inFlight.batchesTotal = batches.length;
      log(`Pushing ${valid.length} items in ${batches.length} batches of ≤${cfg.SYNC_BATCH_SIZE}…`);

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]!;
        const result: BatchResult = await pushBatch(
          batch,
          i + 1,
          cfg,
          deps.fetchImpl ?? fetch,
        );
        report.batches.push(result);
        report.totals.sent += batch.length;
        if (result.accepted) report.totals.accepted += 1;
        report.totals.rowErrors += result.rowErrors.length;
        inFlight.batchesDone = i + 1;
        log(
          `  batch ${i + 1}/${batches.length}: ${result.accepted ? "ok" : `FAILED (${result.error})`}${result.rowErrors.length ? `, ${result.rowErrors.length} row errors` : ""}`,
        );
        if (i < batches.length - 1 && cfg.SYNC_BATCH_DELAY_MS > 0) {
          await sleep(cfg.SYNC_BATCH_DELAY_MS);
        }
      }
    }

    report.status = deriveStatus(report);

    // advance the watermark on every fully-successful run — including runs
    // that found nothing to send (they prove there were no changes up to
    // runStart). Failed batches block the advance so the next run retries the
    // same window; row-level data errors do NOT block it (resending bad data
    // cannot fix it).
    const fullySuccessful =
      report.status !== "failed" && report.batches.every((b) => b.accepted);
    if (!dryRun && !opts.isbn && !opts.limit && fullySuccessful) {
      const state = await readState(cfg.DATA_DIR);
      state.lastSyncAt = report.startedAt;
      if (opts.mode === "full") state.lastFullSyncAt = report.startedAt;
      state.lastRun = summarize(report);
      await writeState(cfg.DATA_DIR, state);
    } else if (!dryRun) {
      const state = await readState(cfg.DATA_DIR);
      state.lastRun = summarize(report);
      await writeState(cfg.DATA_DIR, state);
    }
  } catch (err) {
    report.fatalError =
      err instanceof MulltiplyAuthError ? err.message : String(err);
    report.status = "failed";
  } finally {
    const finished = new Date();
    report.finishedAt = finished.toISOString();
    report.durationMs = finished.getTime() - startedAt.getTime();
    inFlight = null;
    try {
      const file = await writeReport(cfg.DATA_DIR, report);
      log(formatSummary(report));
      log(`Report: ${file}`);
    } catch (reportErr) {
      log(`Failed to write run report: ${String(reportErr)}`);
    }
  }

  return report;
}

function deriveStatus(report: RunReport): RunStatus {
  if (report.fatalError) return "failed";
  const failedBatches = report.batches.filter((b) => !b.accepted).length;
  if (
    failedBatches > 0 ||
    report.totals.invalid > 0 ||
    report.totals.rowErrors > 0
  ) {
    return "completed_with_errors";
  }
  return "completed";
}

function summarize(report: RunReport): NonNullable<import("./types.js").SyncState["lastRun"]> {
  return {
    runId: report.runId,
    mode: report.mode,
    status: report.status,
    finishedAt: report.finishedAt || new Date().toISOString(),
    totals: report.totals,
  };
}
