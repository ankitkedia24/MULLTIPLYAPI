/**
 * Local mock of Mulltiply's Item Sync API for testing without their real key.
 *
 * Implements PUT /v2/items/sync-data per the spec docx INDEPENDENTLY of the
 * sync service's own validator, so tests can catch that validator's blind
 * spots. Accepted items are upserted into an in-memory map keyed by syncId,
 * proving create-or-update semantics across runs.
 *
 * Note on `row` in error responses: the spec's example pairs "row": 1 with
 * "items[1].itemName", which is ambiguous about 0- vs 1-based indexing.
 * This mock uses the 0-based array index.
 */
import Fastify from "fastify";

export interface MockOptions {
  apiKey: string;
  /** Reject every Nth item with a synthetic row error (0 = off). */
  failRowEvery?: number;
  /** Return HTTP 500 on every Nth request (0 = off). */
  error500Every?: number;
  logger?: boolean;
}

interface AnyItem {
  [key: string]: unknown;
  syncId?: unknown;
  itemName?: unknown;
  skus?: unknown;
}

function envelope(data: Record<string, unknown>) {
  return {
    error: false,
    status: true,
    statusCode: 200,
    responseTimestamp: new Date().toISOString(),
    data,
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isPositiveNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Validate one item the way the spec's checklist describes. */
function validateItem(item: AnyItem, seenSkuSyncIds: Set<string>): string[] {
  const errors: string[] = [];
  for (const field of ["itemName", "brandName", "categoryName", "subCategoryName", "syncId"]) {
    if (!isNonEmptyString(item[field])) errors.push(`${field} is required`);
  }
  const skus = item.skus;
  if (!Array.isArray(skus) || skus.length === 0) {
    errors.push("skus must be a non-empty array");
    return errors;
  }
  for (const [i, skuRaw] of skus.entries()) {
    const sku = skuRaw as AnyItem;
    for (const field of [
      "skuName",
      "skuNickName",
      "sellerSKU",
      "productCode",
      "hsnCode",
      "variantType1",
      "variantValue1",
      "variantType2",
      "variantValue2",
      "syncId",
    ]) {
      if (!isNonEmptyString(sku[field])) errors.push(`skus[${i}].${field} is required`);
    }
    if (typeof sku["gst"] !== "number" || !Number.isFinite(sku["gst"]) || (sku["gst"] as number) < 0) {
      errors.push(`skus[${i}].gst must be a number >= 0`);
    }
    const skuSyncId = sku["syncId"];
    if (isNonEmptyString(skuSyncId)) {
      if (seenSkuSyncIds.has(skuSyncId)) errors.push(`skus[${i}].syncId must be globally unique`);
      else seenSkuSyncIds.add(skuSyncId);
    }
    const units = sku["sellingUnits"];
    if (!Array.isArray(units) || units.length === 0) {
      errors.push(`skus[${i}].sellingUnits must be a non-empty array`);
      continue;
    }
    let baseCount = 0;
    for (const [j, unitRaw] of units.entries()) {
      const unit = unitRaw as AnyItem;
      if (!isNonEmptyString(unit["name"])) errors.push(`skus[${i}].sellingUnits[${j}].name is required`);
      for (const numField of ["multiplier", "mrp", "sellingPrice"]) {
        if (!isPositiveNumber(unit[numField])) {
          errors.push(`skus[${i}].sellingUnits[${j}].${numField} must be a positive number`);
        }
      }
      for (const boolField of ["isBaseUnit", "isDefault", "includeGST", "isActive"]) {
        if (typeof unit[boolField] !== "boolean") {
          errors.push(`skus[${i}].sellingUnits[${j}].${boolField} must be a boolean`);
        }
      }
      if (unit["includeGST"] !== true) {
        errors.push(`skus[${i}].sellingUnits[${j}].includeGST must be true`);
      }
      if (unit["isBaseUnit"] === true) baseCount++;
      // spec correction 12-08-2026: syncId required on EVERY selling unit
      if (!isNonEmptyString(unit["syncId"])) {
        errors.push(`skus[${i}].sellingUnits[${j}].syncId is required`);
      }
    }
    if (baseCount !== 1) errors.push(`skus[${i}] must have exactly one base selling unit`);
  }
  return errors;
}

export function buildMockApp(opts: MockOptions) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  const store = new Map<string, AnyItem>();
  const seenSkuSyncIds = new Set<string>();
  let requestCount = 0;

  app.put("/v2/items/sync-data", async (req, reply) => {
    requestCount++;

    if (req.headers["x-api-key"] !== opts.apiKey) {
      return reply.code(401).send({
        error: true,
        status: false,
        statusCode: 401,
        responseTimestamp: new Date().toISOString(),
        data: { message: "Invalid API key" },
      });
    }

    if (opts.error500Every && requestCount % opts.error500Every === 0) {
      return reply.code(500).send({
        error: true,
        status: false,
        statusCode: 500,
        responseTimestamp: new Date().toISOString(),
        data: { message: "Synthetic internal error (chaos mode)" },
      });
    }

    const body = req.body;
    if (!Array.isArray(body)) {
      return reply.code(400).send({
        error: true,
        status: false,
        statusCode: 400,
        responseTimestamp: new Date().toISOString(),
        data: { message: "Request body must be a JSON array of items" },
      });
    }

    const rowErrors: Array<{ row: number; itemName: string; errors: string[] }> = [];
    let processed = 0;

    for (const [row, itemRaw] of body.entries()) {
      const item = itemRaw as AnyItem;
      // items being re-upserted may reuse their own SKU syncIds
      const existing = isNonEmptyString(item.syncId) ? store.get(item.syncId) : undefined;
      if (existing && Array.isArray(existing.skus)) {
        for (const sku of existing.skus as AnyItem[]) {
          if (isNonEmptyString(sku["syncId"])) seenSkuSyncIds.delete(sku["syncId"]);
        }
      }

      const errors = validateItem(item, seenSkuSyncIds);
      if (opts.failRowEvery && (row + 1) % opts.failRowEvery === 0) {
        errors.push("Synthetic row failure (chaos mode)");
      }

      if (errors.length > 0) {
        rowErrors.push({
          row,
          itemName: isNonEmptyString(item.itemName) ? item.itemName : "",
          errors,
        });
        continue;
      }
      store.set(item.syncId as string, item);
      processed++;
    }

    if (rowErrors.length === 0) {
      return reply.send(envelope({ message: "All rows processed successfully" }));
    }
    return reply.send(
      envelope({
        message: "Some rows failed",
        processedCount: processed,
        errorCount: rowErrors.length,
        errors: rowErrors,
      }),
    );
  });

  // Inventory sync API — stock-only updates addressed by selling-unit syncId
  // with the "external://variant/" prefix (docs.mulltiply.ai/inventory).
  app.post("/v2/godowns/thirdparty-stock-sync", async (req, reply) => {
    requestCount++;

    if (req.headers["x-api-key"] !== opts.apiKey) {
      return reply.code(401).send({
        error: true,
        status: false,
        statusCode: 401,
        responseTimestamp: new Date().toISOString(),
        data: { message: "Invalid API key" },
      });
    }

    if (opts.error500Every && requestCount % opts.error500Every === 0) {
      return reply.code(500).send({
        error: true,
        status: false,
        statusCode: 500,
        responseTimestamp: new Date().toISOString(),
        data: { message: "Synthetic internal error (chaos mode)" },
      });
    }

    const body = req.body;
    if (!Array.isArray(body)) {
      return reply.code(400).send({
        error: true,
        status: false,
        statusCode: 400,
        responseTimestamp: new Date().toISOString(),
        data: { message: "Request body must be a JSON array" },
      });
    }

    const PREFIX = "external://variant/";
    const nonProcessablesStocks: Array<{ syncId: string; reason: string }> = [];
    let validRowsCount = 0;

    for (const raw of body) {
      const entry = raw as AnyItem;
      const sid = isNonEmptyString(entry["syncId"]) ? (entry["syncId"] as string) : "";
      const qty = entry["inventoryQuantity"];
      if (!sid.startsWith(PREFIX) || sid.length <= PREFIX.length) {
        nonProcessablesStocks.push({ syncId: sid, reason: "invalid syncId" });
        continue;
      }
      if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) {
        nonProcessablesStocks.push({ syncId: sid, reason: "invalid inventoryQuantity" });
        continue;
      }
      const bare = sid.slice(PREFIX.length);
      const item = store.get(bare);
      if (!item || !Array.isArray(item.skus)) {
        nonProcessablesStocks.push({ syncId: sid, reason: "selling unit not found" });
        continue;
      }
      for (const sku of item.skus as AnyItem[]) {
        const units = sku["sellingUnits"];
        if (!Array.isArray(units)) continue;
        for (const unit of units as AnyItem[]) {
          if (unit["syncId"] === bare) unit["availableQuantity"] = qty;
        }
      }
      validRowsCount++;
    }

    return reply.send(envelope({ validRowsCount, nonProcessablesStocks }));
  });

  app.get("/debug/items", async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return {
      count: store.size,
      syncIds: query.full ? undefined : [...store.keys()],
      items: query.full ? [...store.values()] : undefined,
    };
  });

  app.get("/debug/items/:syncId", async (req, reply) => {
    const { syncId } = req.params as { syncId: string };
    const item = store.get(syncId);
    if (!item) return reply.code(404).send({ error: "not found" });
    return item;
  });

  app.delete("/debug/items", async () => {
    store.clear();
    seenSkuSyncIds.clear();
    return { cleared: true };
  });

  return app;
}

// standalone entrypoint: npm run mock
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("mock/mulltiply-mock.ts");
if (isMain) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env — use defaults
  }
  const port = Number(process.env["MOCK_PORT"]) || 4010;
  const app = buildMockApp({
    apiKey: process.env["MOCK_API_KEY"] || "test-key",
    failRowEvery: Number(process.env["MOCK_FAIL_ROW_EVERY"]) || 0,
    error500Every: Number(process.env["MOCK_500_EVERY"]) || 0,
    logger: true,
  });
  app
    .listen({ port, host: "0.0.0.0" })
    .then(() => console.log(`Mock Mulltiply API listening on :${port} (key: ${process.env["MOCK_API_KEY"] || "test-key"})`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
