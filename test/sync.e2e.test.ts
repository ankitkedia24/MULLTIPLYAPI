import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMockApp } from "../mock/mulltiply-mock.js";
import { readState } from "../src/state.js";
import { runSync } from "../src/sync.js";
import type { BookRow } from "../src/types.js";
import { makeTestConfig } from "./helpers.js";

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "books.json"), "utf8"),
) as BookRow[];

// fixture math: 12 rows — 4 skipped (no price, zero rate, blank name,
// missing publisher), 8 transformed, 1 invalid (duplicate ISBN) → 7 sent
const EXPECTED_SENT = 7;

const fetchFixtures = async () => fixtures;

type MockApp = ReturnType<typeof buildMockApp>;
const openApps: MockApp[] = [];
const tempDirs: string[] = [];

async function startMock(opts: Parameters<typeof buildMockApp>[0]) {
  const app = buildMockApp(opts);
  await app.listen({ port: 0, host: "127.0.0.1" });
  openApps.push(app);
  const address = app.server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  return { app, port: address.port };
}

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "mulltiply-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const silent = () => {};

describe("runSync end-to-end against the mock Mulltiply server", () => {
  it("pushes fixtures, reports accurately, advances the watermark, and upserts on re-run", async () => {
    const { app, port } = await startMock({ apiKey: "test-key" });
    const dataDir = await tempDataDir();
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
    });

    const report = await runSync(
      cfg,
      { mode: "full" },
      { fetchBooksImpl: fetchFixtures, log: silent },
    );

    expect(report.totals.fetched).toBe(12);
    expect(report.totals.skipped).toBe(4);
    expect(report.totals.invalid).toBe(1);
    expect(report.totals.sent).toBe(EXPECTED_SENT);
    expect(report.batches).toHaveLength(2); // batch size 4 → 4 + 3
    expect(report.totals.accepted).toBe(2);
    expect(report.totals.rowErrors).toBe(0);
    expect(report.status).toBe("completed_with_errors"); // the duplicate-ISBN invalid row
    expect(report.invalid[0]!.errors.join(" ")).toContain("duplicate");

    // mock stored exactly the valid items
    const debugRes = await app.inject({ method: "GET", url: "/debug/items" });
    expect(debugRes.json().count).toBe(EXPECTED_SENT);

    // watermark advanced because every batch was accepted
    const state = await readState(dataDir);
    expect(state.lastSyncAt).toBe(report.startedAt);
    expect(state.lastFullSyncAt).toBe(report.startedAt);
    expect(state.lastRun?.runId).toBe(report.runId);

    // re-run: idempotent upsert — still 7 items, not 14
    const report2 = await runSync(
      cfg,
      { mode: "full" },
      { fetchBooksImpl: fetchFixtures, log: silent },
    );
    expect(report2.totals.accepted).toBe(2);
    const debugRes2 = await app.inject({ method: "GET", url: "/debug/items" });
    expect(debugRes2.json().count).toBe(EXPECTED_SENT);
  });

  it("dry run sends nothing and leaves state untouched", async () => {
    const { app, port } = await startMock({ apiKey: "test-key" });
    const dataDir = await tempDataDir();
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
    });

    const report = await runSync(
      cfg,
      { mode: "full", dryRun: true },
      { fetchBooksImpl: fetchFixtures, log: silent },
    );

    expect(report.dryRun).toBe(true);
    expect(report.totals.sent).toBe(0);
    expect(report.batches).toHaveLength(0);
    const debugRes = await app.inject({ method: "GET", url: "/debug/items" });
    expect(debugRes.json().count).toBe(0);
    const state = await readState(dataDir);
    expect(state.lastSyncAt).toBeNull();
  });

  it("recovers from intermittent 500s via retry", { timeout: 20000 }, async () => {
    const { port } = await startMock({ apiKey: "test-key", error500Every: 2 });
    const dataDir = await tempDataDir();
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
    });

    const report = await runSync(
      cfg,
      { mode: "full" },
      { fetchBooksImpl: fetchFixtures, log: silent },
    );

    expect(report.totals.accepted).toBe(2);
    expect(report.batches.some((b) => b.attempts > 1)).toBe(true);
    expect(["completed", "completed_with_errors"]).toContain(report.status);
  });

  it("collects per-row errors from partial failures without failing the run", async () => {
    const { port } = await startMock({ apiKey: "test-key", failRowEvery: 3 });
    const dataDir = await tempDataDir();
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
    });

    const report = await runSync(
      cfg,
      { mode: "full" },
      { fetchBooksImpl: fetchFixtures, log: silent },
    );

    expect(report.totals.rowErrors).toBeGreaterThan(0);
    expect(report.status).toBe("completed_with_errors");
    // row errors map back to real ISBNs from the batch
    const flagged = report.batches.flatMap((b) => b.rowErrors);
    for (const e of flagged) expect(e.isbn).not.toBe("");
  });

  it("incremental without a watermark uses a bounded window, never a full fetch", async () => {
    const { port } = await startMock({ apiKey: "test-key" });
    const dataDir = await tempDataDir(); // empty — no state.json, no watermark
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
    });

    let receivedSince: string | undefined;
    const before = Date.now();
    await runSync(
      cfg,
      { mode: "incremental" },
      {
        fetchBooksImpl: async (_cfg, opts) => {
          receivedSince = opts?.since;
          return [];
        },
        log: silent,
      },
    );

    expect(receivedSince).toBeDefined(); // the old behaviour passed undefined = fetch everything
    const sinceMs = new Date(receivedSince!).getTime();
    const windowMs = cfg.SYNC_INCR_WINDOW_MINUTES * 60_000;
    expect(before - sinceMs).toBeGreaterThanOrEqual(windowMs - 5_000);
    expect(before - sinceMs).toBeLessThanOrEqual(windowMs + 60_000);
  });

  it("a zero-change successful incremental advances the watermark", async () => {
    const { port } = await startMock({ apiKey: "test-key" });
    const dataDir = await tempDataDir();
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
    });

    const report = await runSync(
      cfg,
      { mode: "incremental" },
      { fetchBooksImpl: async () => [], log: silent },
    );

    expect(report.status).toBe("completed");
    expect(report.totals.sent).toBe(0);
    const state = await readState(dataDir);
    expect(state.lastSyncAt).toBe(report.startedAt);
  });

  it("aborts the whole run on a bad API key", async () => {
    const { port } = await startMock({ apiKey: "different-key" });
    const dataDir = await tempDataDir();
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${port}`,
      DATA_DIR: dataDir,
    });

    const report = await runSync(
      cfg,
      { mode: "full" },
      { fetchBooksImpl: fetchFixtures, log: silent },
    );

    expect(report.status).toBe("failed");
    expect(report.fatalError).toContain("API key");
    const state = await readState(dataDir);
    expect(state.lastSyncAt).toBeNull();
  });
});
