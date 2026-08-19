import { computeFingerprint, loadFingerprints, saveFingerprints, } from "./fingerprint.js";
import { MulltiplyAuthError, pushBatch, pushStockBatch, } from "./mulltiply-client.js";
import { formatSummary, writeReport } from "./report.js";
import { readState, writeState } from "./state.js";
import { fetchBooks, sleep } from "./supabase.js";
import { bookToItem } from "./transform.js";
import { validateItems } from "./validate.js";
let inFlight = null;
export function getInFlight() {
    return inFlight;
}
export class SyncBusyError extends Error {
    constructor(runId) {
        super(`A sync run is already in progress (${runId})`);
        this.name = "SyncBusyError";
    }
}
/** Overlap subtracted from the watermark so clock skew can't drop rows. */
const INCREMENTAL_OVERLAP_MS = 60_000;
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
export async function runSync(cfg, opts, deps = {}) {
    if (inFlight)
        throw new SyncBusyError(inFlight.runId);
    const log = deps.log ?? ((msg) => console.log(msg));
    const fetchBooksImpl = deps.fetchBooksImpl ?? fetchBooks;
    const dryRun = opts.dryRun ?? false;
    if (!dryRun && !cfg.MULLTIPLY_API_KEY) {
        throw new Error("MULLTIPLY_API_KEY is not set — use --dry-run or configure the key");
    }
    const startedAt = new Date();
    const runId = opts.runId ?? startedAt.toISOString().replace(/[:.]/g, "-").replace("Z", "");
    inFlight = {
        runId,
        mode: opts.mode,
        startedAt: startedAt.toISOString(),
        phase: "fetching",
        batchesDone: 0,
        batchesTotal: null,
    };
    const report = {
        runId,
        mode: opts.mode,
        dryRun,
        startedAt: startedAt.toISOString(),
        finishedAt: "",
        durationMs: 0,
        status: "completed",
        totals: {
            fetched: 0,
            skipped: 0,
            invalid: 0,
            sent: 0,
            accepted: 0,
            rowErrors: 0,
            stockOnly: 0,
            stockRejected: 0,
        },
        warningCounts: {},
        skipped: [],
        invalid: [],
        batches: [],
    };
    try {
        // resolve the incremental watermark
        let since = opts.since;
        if (opts.mode === "incremental" && !since && !opts.isbn) {
            const state = await readState(cfg.DATA_DIR);
            if (state.lastSyncAt) {
                since = new Date(new Date(state.lastSyncAt).getTime() - INCREMENTAL_OVERLAP_MS).toISOString();
            }
            else {
                // never fall back to a full fetch — on ephemeral hosting the state
                // file can vanish (deploys/restarts), and refetching everything every
                // 30 minutes floods the partner's ingestion queue. A bounded window
                // covers the gap; the nightly full sync reconciles anything older.
                since = new Date(startedAt.getTime() - cfg.SYNC_INCR_WINDOW_MINUTES * 60_000).toISOString();
                log(`No previous sync watermark — using bounded ${cfg.SYNC_INCR_WINDOW_MINUTES}-minute window (since ${since}).`);
            }
        }
        log(`Fetching books (filter=${cfg.SYNC_BOOK_FILTER}${since ? `, since=${since}` : ""}${opts.isbn ? `, isbn=${opts.isbn}` : ""}${opts.limit ? `, limit=${opts.limit}` : ""})…`);
        const rows = await fetchBooksImpl(cfg, {
            since,
            isbn: opts.isbn,
            limit: opts.limit,
            onProgress: (fetched, total) => log(`  fetched ${fetched}${total !== null ? `/${total}` : ""} rows`),
        }, deps.fetchImpl ?? fetch);
        report.totals.fetched = rows.length;
        inFlight.phase = "transforming";
        const items = [];
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
        log(`Transformed ${items.length} items (${report.totals.skipped} skipped, ${invalid.length} invalid).`);
        // ---- route: stock-only changes → inventory API, the rest → item-sync ----
        const fpCache = new Map();
        const fingerprint = (item) => {
            let fp = fpCache.get(item.syncId);
            if (!fp) {
                fp = computeFingerprint(item);
                fpCache.set(item.syncId, fp);
            }
            return fp;
        };
        let itemsToSync = valid;
        const stockUpdates = [];
        const routeStock = !dryRun &&
            cfg.SYNC_STOCK_API_ENABLED &&
            opts.mode === "incremental" &&
            !opts.isbn;
        const fingerprints = dryRun ? {} : await loadFingerprints(cfg.DATA_DIR);
        if (routeStock && valid.length > 0) {
            const routed = [];
            for (const item of valid) {
                if (fingerprints[item.syncId] === fingerprint(item)) {
                    stockUpdates.push({
                        isbn: item.syncId,
                        quantity: item.skus[0]?.sellingUnits[0]?.availableQuantity ?? 0,
                    });
                }
                else {
                    routed.push(item);
                }
            }
            itemsToSync = routed;
            report.totals.stockOnly = stockUpdates.length;
            if (stockUpdates.length > 0) {
                log(`Routing: ${routed.length} via item-sync, ${stockUpdates.length} stock-only via inventory API.`);
            }
        }
        if (dryRun) {
            log("Dry run — nothing sent to Mulltiply.");
        }
        else if (valid.length === 0) {
            log("Nothing to send.");
        }
        else {
            const byIsbn = new Map(valid.map((i) => [i.syncId, i]));
            const pushedItemBatches = [];
            const itemBatches = chunk(itemsToSync, cfg.SYNC_BATCH_SIZE);
            const stockBatches = chunk(stockUpdates, cfg.SYNC_STOCK_BATCH_SIZE);
            inFlight.phase = "pushing";
            inFlight.batchesTotal = itemBatches.length + stockBatches.length;
            if (itemsToSync.length > 0) {
                log(`Pushing ${itemsToSync.length} items in ${itemBatches.length} batches of ≤${cfg.SYNC_BATCH_SIZE}…`);
            }
            const pushItemBatch = async (batch) => {
                const result = await pushBatch(batch, report.batches.length + 1, cfg, deps.fetchImpl ?? fetch);
                report.batches.push(result);
                pushedItemBatches.push({ items: batch, result });
                report.totals.sent += batch.length;
                if (result.accepted)
                    report.totals.accepted += 1;
                report.totals.rowErrors += result.rowErrors.length;
                inFlight.batchesDone += 1;
                log(`  items batch ${result.batchNo}: ${result.accepted ? "ok" : `FAILED (${result.error})`}${result.rowErrors.length ? `, ${result.rowErrors.length} row errors` : ""}`);
                return result;
            };
            for (const batch of itemBatches) {
                await pushItemBatch(batch);
                if (cfg.SYNC_BATCH_DELAY_MS > 0)
                    await sleep(cfg.SYNC_BATCH_DELAY_MS);
            }
            if (stockBatches.length > 0) {
                log(`Pushing ${stockUpdates.length} stock updates in ${stockBatches.length} batches of ≤${cfg.SYNC_STOCK_BATCH_SIZE}…`);
                const rejectedIsbns = new Set();
                for (const batch of stockBatches) {
                    const result = await pushStockBatch(batch, report.batches.length + 1, cfg, deps.fetchImpl ?? fetch);
                    report.batches.push(result);
                    if (result.accepted)
                        report.totals.accepted += 1;
                    inFlight.batchesDone += 1;
                    for (const e of result.rowErrors) {
                        if (e.isbn)
                            rejectedIsbns.add(e.isbn);
                    }
                    log(`  stock batch ${result.batchNo}: ${result.accepted ? "ok" : `FAILED (${result.error})`}${result.rowErrors.length ? `, ${result.rowErrors.length} rejected` : ""}`);
                    if (cfg.SYNC_BATCH_DELAY_MS > 0)
                        await sleep(cfg.SYNC_BATCH_DELAY_MS);
                }
                // self-heal: stock rows their inventory API rejected (e.g. selling
                // unit not found) are re-sent as full items in the same run
                report.totals.stockRejected = rejectedIsbns.size;
                if (rejectedIsbns.size > 0) {
                    const fallback = [...rejectedIsbns]
                        .map((isbn) => byIsbn.get(isbn))
                        .filter((i) => Boolean(i));
                    if (fallback.length > 0) {
                        log(`Re-sending ${fallback.length} rejected stock rows as full item-sync…`);
                        for (const batch of chunk(fallback, cfg.SYNC_BATCH_SIZE)) {
                            inFlight.batchesTotal = (inFlight.batchesTotal ?? 0) + 1;
                            await pushItemBatch(batch);
                        }
                    }
                }
            }
            // remember the master-data fingerprint of every successfully
            // item-synced book, so future stock-only changes can be routed cheaply
            if (pushedItemBatches.length > 0) {
                let changed = false;
                for (const { items: batchItems, result } of pushedItemBatches) {
                    if (!result.accepted)
                        continue;
                    const errored = new Set(result.rowErrors.map((e) => e.isbn));
                    for (const item of batchItems) {
                        if (errored.has(item.syncId))
                            continue;
                        fingerprints[item.syncId] = fingerprint(item);
                        changed = true;
                    }
                }
                if (changed)
                    await saveFingerprints(cfg.DATA_DIR, fingerprints);
            }
        }
        report.status = deriveStatus(report);
        // advance the watermark on every fully-successful run — including runs
        // that found nothing to send (they prove there were no changes up to
        // runStart). Failed batches block the advance so the next run retries the
        // same window; row-level data errors do NOT block it (resending bad data
        // cannot fix it).
        const fullySuccessful = report.status !== "failed" && report.batches.every((b) => b.accepted);
        if (!dryRun && !opts.isbn && !opts.limit && fullySuccessful) {
            const state = await readState(cfg.DATA_DIR);
            state.lastSyncAt = report.startedAt;
            if (opts.mode === "full")
                state.lastFullSyncAt = report.startedAt;
            state.lastRun = summarize(report);
            await writeState(cfg.DATA_DIR, state);
        }
        else if (!dryRun) {
            const state = await readState(cfg.DATA_DIR);
            state.lastRun = summarize(report);
            await writeState(cfg.DATA_DIR, state);
        }
    }
    catch (err) {
        report.fatalError =
            err instanceof MulltiplyAuthError ? err.message : String(err);
        report.status = "failed";
    }
    finally {
        const finished = new Date();
        report.finishedAt = finished.toISOString();
        report.durationMs = finished.getTime() - startedAt.getTime();
        inFlight = null;
        try {
            const file = await writeReport(cfg.DATA_DIR, report);
            log(formatSummary(report));
            log(`Report: ${file}`);
        }
        catch (reportErr) {
            log(`Failed to write run report: ${String(reportErr)}`);
        }
    }
    return report;
}
function deriveStatus(report) {
    if (report.fatalError)
        return "failed";
    const failedBatches = report.batches.filter((b) => !b.accepted).length;
    if (failedBatches > 0 ||
        report.totals.invalid > 0 ||
        report.totals.rowErrors > 0) {
        return "completed_with_errors";
    }
    return "completed";
}
function summarize(report) {
    return {
        runId: report.runId,
        mode: report.mode,
        status: report.status,
        finishedAt: report.finishedAt || new Date().toISOString(),
        totals: report.totals,
    };
}
//# sourceMappingURL=sync.js.map