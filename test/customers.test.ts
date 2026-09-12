import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMockApp } from "../mock/mulltiply-mock.js";
import { runCustomerSync } from "../src/customers/sync.js";
import { customerSyncId, customerToRetailer, stateCode } from "../src/customers/transform.js";
import type { CustomerFeedRow } from "../src/customers/types.js";
import { readState } from "../src/state.js";
import { makeTestConfig } from "./helpers.js";

const row = (over: Partial<CustomerFeedRow> = {}): CustomerFeedRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  customer_code: "HO/A001",
  customer_name: "A R BOOK HOUSE",
  alias_name: "ARBH",
  email: "Shop@Example.com",
  gstin: "21ABCDE1234F1Z5",
  address: "Station Road",
  city: "Bhubaneswar",
  state: "Odisha",
  pin_code: "751001",
  country: "India",
  mobile: "9337857736",
  last_sale_date: "2026-08-01",
  updated_at: "2026-09-01T00:00:00Z",
  changed_at: "2026-09-01T00:00:00Z",
  eligible: true,
  ...over,
});

describe("customerToRetailer", () => {
  it("maps a customer to one retailer with one primary shop", () => {
    const r = customerToRetailer(row(), makeTestConfig());
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const t = r.retailer;
    expect(t.syncId).toBe("HO-A001");
    expect(t.name).toBe("A R BOOK HOUSE");
    expect(t.phone).toBe("9337857736");
    expect(t.phoneCountryCode).toBe("+91");
    expect(t.email).toBe("shop@example.com");
    expect(t.gstNumber).toBe("21ABCDE1234F1Z5");
    expect(t.tags).toEqual(["ARBH"]);
    expect(t.billingAddress.provinceCode).toBe("OD");
    expect(t.billingAddress.isBillingAddress).toBe(true);
    expect(t.shops).toHaveLength(1);
    expect(t.shops[0]!.syncId).toBe("HO-A001/MAIN");
    expect(t.shops[0]!.customerSyncId).toBe("HO-A001");
    expect(t.shops[0]!.isPrimary).toBe(true);
    expect(t.shops[0]!.shippingAddress.addressType).toBe("SHIPPING_ADDRESS");
    expect(r.warnings).toEqual([]);
    // no balances leave the ERP
    expect(JSON.stringify(t)).not.toMatch(/outStanding/i);
  });

  it("skips a customer without a valid mobile, with the reason", () => {
    const r = customerToRetailer(row({ mobile: null }), makeTestConfig());
    expect(r).toMatchObject({ status: "skip", reason: "no valid mobile number", customerCode: "HO/A001" });
  });

  it("drops an invalid email / GSTIN with warnings instead of failing the row", () => {
    const r = customerToRetailer(row({ email: "not-an-email", gstin: "BAD" }), makeTestConfig());
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.retailer.email).toBe("");
    expect(r.retailer.gstNumber).toBeUndefined();
    expect(r.warnings).toEqual(expect.arrayContaining(["email_dropped_invalid", "gstin_dropped_invalid"]));
  });

  it("state codes: names, old names, codes, unknown", () => {
    expect(stateCode("Odisha")).toBe("OD");
    expect(stateCode("ORISSA")).toBe("OD");
    expect(stateCode("west bengal")).toBe("WB");
    expect(stateCode("WB")).toBe("WB");
    expect(stateCode("Tamilnadu")).toBe("TN");
    expect(stateCode("Atlantis")).toBe("");
    expect(customerSyncId(" HO/SC217 ")).toBe("HO-SC217");
  });
});

type MockApp = ReturnType<typeof buildMockApp>;
const openApps: MockApp[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const silent = () => {};

describe("runCustomerSync against the mock", () => {
  it("pushes, reports, advances the customer watermark, upserts on re-run, and lists skips", async () => {
    const app = buildMockApp({ apiKey: "test-key" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    openApps.push(app);
    const address = app.server.address();
    if (typeof address === "string" || !address) throw new Error("no port");
    const dataDir = await mkdtemp(join(tmpdir(), "mulltiply-cust-"));
    tempDirs.push(dataDir);
    const cfg = makeTestConfig({
      MULLTIPLY_BASE_URL: `http://127.0.0.1:${address.port}`,
      DATA_DIR: dataDir,
      CUSTOMER_BATCH_SIZE: "2",
    });
    const fixtures: CustomerFeedRow[] = [
      row(),
      row({ id: "2", customer_code: "HO/A002", customer_name: "B BOOKS", mobile: "9876543210", alias_name: null }),
      row({ id: "3", customer_code: "HO/A003", customer_name: "NO PHONE STORE", mobile: null }),
      row({ id: "4", customer_code: "HO/A004", customer_name: "C STORE", mobile: "8888877777" }),
    ];

    const report = await runCustomerSync(
      cfg,
      { mode: "full" },
      { fetchCustomersImpl: async () => fixtures, log: silent },
    );
    expect(report.status).toBe("completed");
    expect(report.totals).toMatchObject({ fetched: 4, skipped: 1, sent: 3, accepted: 2, rowErrors: 0 });
    expect(report.skipped[0]).toMatchObject({ customerCode: "HO/A003", reason: "no valid mobile number" });
    expect(report.batches).toHaveLength(2);

    const state = await readState(dataDir);
    expect(state.customer?.lastSyncAt).toBe(report.startedAt);
    expect(state.customer?.lastFullSyncAt).toBe(report.startedAt);
    // item watermark untouched
    expect(state.lastSyncAt).toBeNull();

    const stored = await app.inject({ method: "GET", url: "/debug/retailers" });
    expect(stored.json().count).toBe(3);
    expect(stored.json().syncIds).toEqual(expect.arrayContaining(["HO-A001", "HO-A002", "HO-A004"]));

    // re-run: upsert, no duplicates, watermark moves forward
    const again = await runCustomerSync(
      cfg,
      { mode: "incremental" },
      { fetchCustomersImpl: async () => fixtures, log: silent },
    );
    expect(again.status).toBe("completed");
    expect((await app.inject({ method: "GET", url: "/debug/retailers" })).json().count).toBe(3);
    const state2 = await readState(dataDir);
    expect(state2.customer?.lastSyncAt).toBe(again.startedAt);
  });

  it("maps their nonProcessableRows back to syncIds and marks the run with errors", async () => {
    const app = buildMockApp({ apiKey: "test-key", failRowEvery: 2 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    openApps.push(app);
    const address = app.server.address();
    if (typeof address === "string" || !address) throw new Error("no port");
    const dataDir = await mkdtemp(join(tmpdir(), "mulltiply-cust-"));
    tempDirs.push(dataDir);
    const cfg = makeTestConfig({ MULLTIPLY_BASE_URL: `http://127.0.0.1:${address.port}`, DATA_DIR: dataDir });
    const fixtures = [row(), row({ id: "2", customer_code: "HO/A002", customer_name: "B BOOKS", mobile: "9876543210" })];
    const report = await runCustomerSync(cfg, { mode: "full" }, { fetchCustomersImpl: async () => fixtures, log: silent });
    expect(report.status).toBe("completed_with_errors");
    expect(report.totals.rowErrors).toBe(1);
    expect(report.batches[0]!.rowErrors[0]).toMatchObject({ syncId: "HO-A002", customerName: "B BOOKS" });
  });

  it("dry run sends nothing and leaves no watermark", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mulltiply-cust-"));
    tempDirs.push(dataDir);
    const cfg = makeTestConfig({ DATA_DIR: dataDir });
    const report = await runCustomerSync(cfg, { mode: "full", dryRun: true }, { fetchCustomersImpl: async () => [row()], log: silent });
    expect(report.totals.sent).toBe(0);
    expect((await readState(dataDir)).customer).toBeUndefined();
  });
});
