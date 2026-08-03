import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { readLatestReport } from "./report.js";
import { startScheduler } from "./scheduler.js";
import { readState } from "./state.js";
import { fetchBooks } from "./supabase.js";
import { SyncBusyError, getInFlight, runSync } from "./sync.js";
import { bookToItem } from "./transform.js";
import type { MulltiplyItem } from "./types.js";
import { validateItems } from "./validate.js";

const cfg = loadConfig();

if (!cfg.ADMIN_API_KEY) {
  console.error("ADMIN_API_KEY must be set to run the API server.");
  process.exit(1);
}

const app = Fastify({ logger: true });

function keysMatch(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(cfg.ADMIN_API_KEY).digest();
  return timingSafeEqual(a, b);
}

app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/health" || req.url.startsWith("/health?")) return;
  const key = req.headers["x-admin-key"];
  if (!keysMatch(typeof key === "string" ? key : undefined)) {
    return reply.code(401).send({ error: "invalid or missing x-admin-key" });
  }
});

app.get("/health", async () => {
  const state = await readState(cfg.DATA_DIR);
  return {
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    inFlight: getInFlight(),
    lastRun: state.lastRun,
  };
});

const syncBodySchema = z
  .object({
    mode: z.enum(["full", "incremental"]).default("full"),
    dryRun: z.boolean().default(false),
    limit: z.number().int().positive().max(100000).optional(),
    isbn: z.string().min(1).optional(),
  })
  .default({ mode: "full", dryRun: false });

app.post("/sync", async (req, reply) => {
  const parsed = syncBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.issues });
  }
  const inFlight = getInFlight();
  if (inFlight) {
    return reply.code(409).send({ error: "sync already running", inFlight });
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const opts = { ...parsed.data, runId };
  // fire-and-forget: progress is visible via GET /status
  void runSync(cfg, opts, { log: (m) => app.log.info(m) }).catch((err) => {
    if (!(err instanceof SyncBusyError)) app.log.error(err);
  });
  return reply.code(202).send({ started: true, runId, opts: parsed.data });
});

app.get("/preview", async (req, reply) => {
  const query = req.query as Record<string, string | undefined>;
  const isbn = query.isbn?.trim() || undefined;
  const limit = isbn ? undefined : Math.min(Number(query.limit) || 5, 100);

  const rows = await fetchBooks(cfg, { isbn, limit });
  const items: MulltiplyItem[] = [];
  const skipped: Array<{ isbn: string; bookName: string; reason: string }> = [];
  const warningCounts: Record<string, number> = {};

  for (const row of rows) {
    const result = bookToItem(row, cfg);
    if (result.status === "skip") {
      skipped.push({ isbn: result.isbn, bookName: result.bookName, reason: result.reason });
    } else {
      for (const w of result.warnings) warningCounts[w] = (warningCounts[w] ?? 0) + 1;
      items.push(result.item);
    }
  }
  const { valid, invalid } = validateItems(items);

  return reply.send({
    fetched: rows.length,
    validCount: valid.length,
    skipped,
    invalid,
    warningCounts,
    note: "payload is exactly what would be PUT to /v2/items/sync-data",
    payload: valid,
  });
});

app.get("/status", async () => {
  const state = await readState(cfg.DATA_DIR);
  const latestReport = await readLatestReport(cfg.DATA_DIR);
  return {
    inFlight: getInFlight(),
    state,
    latestReport,
  };
});

if (cfg.SYNC_SCHEDULE_ENABLED) {
  startScheduler(cfg, (m) => app.log.info(m));
} else {
  app.log.info("Scheduler disabled (SYNC_SCHEDULE_ENABLED=false)");
}

app
  .listen({ port: cfg.PORT, host: "0.0.0.0" })
  .then(() => console.log(`Mulltiply Item Sync API listening on :${cfg.PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
