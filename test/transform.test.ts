import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bookToItem } from "../src/transform.js";
import type { BookRow, TransformResult } from "../src/types.js";
import { makeTestConfig } from "./helpers.js";

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "books.json"), "utf8"),
) as BookRow[];

const cfg = makeTestConfig();

function byIsbn(isbn: string): BookRow {
  const row = fixtures.find((r) => r.isbn?.trim() === isbn);
  if (!row) throw new Error(`fixture ${isbn} not found`);
  return row;
}

function okItem(result: TransformResult) {
  if (result.status !== "ok") throw new Error(`expected ok, got skip: ${result.reason}`);
  return result;
}

describe("bookToItem", () => {
  it("maps a fully populated book", () => {
    const { item, warnings } = okItem(bookToItem(byIsbn("9780001000018"), cfg));
    expect(item.syncId).toBe("9780001000018");
    expect(item.itemName).toBe("Physics Fundamentals Class 12");
    expect(item.brandName).toBe("BHARATI BHAWAN");
    expect(item.categoryName).toBe("SCHOOL BOOKS");
    expect(item.subCategoryName).toBe("SCIENCE");
    expect(item.description).toBe("CBSE Physics textbook");
    expect(warnings).toEqual([]);

    const sku = item.skus[0]!;
    expect(item.skus).toHaveLength(1);
    expect(sku.syncId).toBe("9780001000018");
    expect(sku.sellerSKU).toBe("9780001000018");
    expect(sku.productCode).toBe("9780001000018");
    expect(sku.barCode).toBe("9780001000018");
    expect(sku.hsnCode).toBe("4901");
    expect(sku.gst).toBe(0);
    expect(sku.variantType1).toBe("Binding");
    expect(sku.variantValue1).toBe("PB");
    expect(sku.variantType2).toBe("Language");
    expect(sku.variantValue2).toBe("English");
    expect(sku.tags).toBeNull();

    const unit = sku.sellingUnits[0]!;
    expect(sku.sellingUnits).toHaveLength(1);
    expect(unit).toMatchObject({
      name: "PCS",
      multiplier: 1,
      mrp: 495,
      sellingPrice: 495, // SYNC_PRICE_FIELD defaults to sale_rate (MRP)
      availableQuantity: 25,
      isBaseUnit: true,
      isDefault: true,
      includeGST: true,
      isActive: true,
    });
  });

  it("applies category/sub-category/binding/language fallbacks with warnings", () => {
    const { item, warnings } = okItem(bookToItem(byIsbn("9780001000025"), cfg));
    expect(item.categoryName).toBe("BOOKS");
    expect(item.subCategoryName).toBe("GENERAL");
    expect(item.skus[0]!.variantValue1).toBe("PB");
    expect(item.skus[0]!.variantValue2).toBe("English");
    expect(item.description).toBe("A ROSS | HARPER COLLINS");
    expect(warnings).toContain("category_fallback");
    expect(warnings).toContain("sub_category_fallback");
    expect(warnings).toContain("binding_defaulted");
    expect(warnings).toContain("language_defaulted");
  });

  it("uses subject and class_name as category fallbacks before defaults", () => {
    const { item } = okItem(bookToItem(byIsbn("9780001000032"), cfg));
    expect(item.categoryName).toBe("DICTIONARY");
    expect(item.subCategoryName).toBe("10");
    expect(item.skus[0]!.variantValue1).toBe("HB");
    expect(item.skus[0]!.variantValue2).toBe("Odia");
  });

  it("clamps negative stock to 0 with a warning", () => {
    const result = okItem(bookToItem(byIsbn("9780001000032"), cfg));
    expect(result.item.skus[0]!.sellingUnits[0]!.availableQuantity).toBe(0);
    expect(result.warnings).toContain("negative_stock_clamped");
  });

  it("skips books with null or zero sale_rate", () => {
    expect(bookToItem(byIsbn("9780001000049"), cfg)).toMatchObject({
      status: "skip",
      reason: expect.stringContaining("sale_rate"),
    });
    expect(bookToItem(byIsbn("9780001000056"), cfg)).toMatchObject({
      status: "skip",
    });
  });

  it("skips books with blank book_name or publisher", () => {
    expect(bookToItem(byIsbn("9780001000087"), cfg)).toMatchObject({
      status: "skip",
      reason: "missing book_name",
    });
    expect(bookToItem(byIsbn("9780001000100"), cfg)).toMatchObject({
      status: "skip",
      reason: "missing publisher_name",
    });
  });

  it("trims whitespace in isbn and collapses runs in the title", () => {
    const { item } = okItem(bookToItem(byIsbn("9780001000063"), cfg));
    expect(item.syncId).toBe("9780001000063");
    expect(item.itemName).toBe("Whitespace Padded Title");
  });

  it("truncates skuNickName to 60 chars but keeps full itemName", () => {
    const { item } = okItem(bookToItem(byIsbn("9780001000070"), cfg));
    expect(item.itemName.length).toBeGreaterThan(60);
    expect(item.skus[0]!.skuNickName.length).toBeLessThanOrEqual(60);
    expect(item.skus[0]!.skuName).toBe(item.itemName);
  });

  it("emits image fields only when cover_image_url is present", () => {
    const withImage = okItem(bookToItem(byIsbn("9780001000094"), cfg)).item;
    expect(withImage.itemImageSource).toBe("OTHERS");
    expect(withImage.itemImageLink).toEqual([
      "https://example.com/covers/9780001000094.jpg",
    ]);
    expect(withImage.skus[0]!.skuImageSource).toBe("OTHERS");

    const noImage = okItem(bookToItem(byIsbn("9780001000018"), cfg)).item;
    expect(noImage).not.toHaveProperty("itemImageSource");
    expect(noImage).not.toHaveProperty("itemImageLink");
  });

  it("coerces string-typed numerics defensively", () => {
    const { item } = okItem(bookToItem(byIsbn("9780001000117"), cfg));
    const unit = item.skus[0]!.sellingUnits[0]!;
    expect(unit.mrp).toBe(316.01);
    expect(unit.sellingPrice).toBe(316.01);
    expect(unit.availableQuantity).toBe(4);
  });

  it("strips Excel backtick artifacts from codes and gates barCode on ISBN shape", () => {
    const base = byIsbn("9780001000018");
    // backtick-prefixed ISBN (Excel text-marker artifact seen in live data)
    const dirty = { ...base, isbn: "`9789394106895" };
    const { item: cleaned } = okItem(bookToItem(dirty, cfg));
    expect(cleaned.syncId).toBe("9789394106895");
    expect(cleaned.skus[0]!.barCode).toBe("9789394106895");

    // internal non-ISBN item codes stay as syncId but get no barcode
    const internalCode = { ...base, isbn: "COB" };
    const { item: internal } = okItem(bookToItem(internalCode, cfg));
    expect(internal.syncId).toBe("COB");
    expect(internal.skus[0]!.barCode).toBeNull();

    // ISBN-10 with X check digit is still a valid barcode
    const isbn10 = { ...base, isbn: "030640615X" };
    const { item: ten } = okItem(bookToItem(isbn10, cfg));
    expect(ten.skus[0]!.barCode).toBe("030640615X");
  });

  it("respects SYNC_PRICE_FIELD when configured", () => {
    const netCfg = makeTestConfig({ SYNC_PRICE_FIELD: "sale_net_price" });
    const { item } = okItem(bookToItem(byIsbn("9780001000018"), netCfg));
    const unit = item.skus[0]!.sellingUnits[0]!;
    expect(unit.mrp).toBe(495);
    expect(unit.sellingPrice).toBe(420.75);
  });
});
