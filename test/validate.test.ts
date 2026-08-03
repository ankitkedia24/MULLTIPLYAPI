import { describe, expect, it } from "vitest";
import type { MulltiplyItem } from "../src/types.js";
import { validateItems } from "../src/validate.js";

function goodItem(syncId: string): MulltiplyItem {
  return {
    itemName: `Book ${syncId}`,
    description: "desc",
    brandName: "PUBLISHER",
    categoryName: "BOOKS",
    subCategoryName: "GENERAL",
    syncId,
    skus: [
      {
        skuName: `Book ${syncId}`,
        skuNickName: `Book ${syncId}`,
        sellerSKU: syncId,
        tags: null,
        productCode: syncId,
        barCode: syncId,
        hsnCode: "4901",
        gst: 0,
        variantType1: "Binding",
        variantValue1: "PB",
        variantType2: "Language",
        variantValue2: "English",
        syncId,
        sellingUnits: [
          {
            name: "PCS",
            multiplier: 1,
            mrp: 100,
            sellingPrice: 100,
            availableQuantity: 5,
            isBaseUnit: true,
            isDefault: true,
            includeGST: true,
            isActive: true,
          },
        ],
      },
    ],
  };
}

describe("validateItems", () => {
  it("passes well-formed items", () => {
    const { valid, invalid } = validateItems([goodItem("A1"), goodItem("A2")]);
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(0);
  });

  it("rejects duplicate item and SKU syncIds across the run", () => {
    const { valid, invalid } = validateItems([goodItem("DUP"), goodItem("DUP")]);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.errors.join(" ")).toContain("duplicate");
  });

  it("rejects missing required fields", () => {
    const bad = goodItem("B1");
    bad.brandName = "";
    bad.skus[0]!.hsnCode = "";
    const { valid, invalid } = validateItems([bad]);
    expect(valid).toHaveLength(0);
    expect(invalid[0]!.errors.some((e) => e.startsWith("brandName"))).toBe(true);
    expect(invalid[0]!.errors.some((e) => e.includes("hsnCode"))).toBe(true);
  });

  it("rejects non-positive prices and multipliers", () => {
    const bad = goodItem("B2");
    bad.skus[0]!.sellingUnits[0]!.mrp = 0;
    bad.skus[0]!.sellingUnits[0]!.multiplier = -1;
    const { invalid } = validateItems([bad]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.errors.join(" ")).toMatch(/mrp|multiplier/);
  });

  it("requires exactly one base unit with multiplier 1", () => {
    const bad = goodItem("B3");
    bad.skus[0]!.sellingUnits[0]!.isBaseUnit = false;
    bad.skus[0]!.sellingUnits[0]!.syncId = "B3-CTN";
    const { invalid } = validateItems([bad]);
    expect(invalid[0]!.errors.join(" ")).toContain("isBaseUnit");
  });

  it("requires syncId on non-base units", () => {
    const bad = goodItem("B4");
    bad.skus[0]!.sellingUnits.push({
      name: "CTN",
      multiplier: 10,
      mrp: 1000,
      sellingPrice: 1000,
      isBaseUnit: false,
      isDefault: false,
      includeGST: true,
      isActive: true,
    });
    const { invalid } = validateItems([bad]);
    expect(invalid[0]!.errors.join(" ")).toContain("syncId");
  });
});
