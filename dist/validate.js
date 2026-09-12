import { z } from "zod";
const nonEmpty = z.string().min(1);
const positiveNumber = z.number().finite().positive();
const sellingUnitSchema = z.object({
    name: nonEmpty,
    multiplier: positiveNumber,
    mrp: positiveNumber,
    sellingPrice: positiveNumber,
    availableQuantity: z.number().int().min(0).optional(),
    isBaseUnit: z.boolean(),
    isDefault: z.boolean(),
    includeGST: z.literal(true),
    // required on EVERY unit since Mulltiply's 12-08-2026 spec correction —
    // their inventory-sync API addresses selling units by this id
    syncId: nonEmpty,
    isActive: z.boolean(),
});
const skuSchema = z
    .object({
    skuName: nonEmpty,
    skuNickName: nonEmpty,
    sellerSKU: nonEmpty,
    tags: z.array(z.string()).nullable(),
    productCode: nonEmpty,
    barCode: z.string().nullable(),
    hsnCode: nonEmpty,
    gst: z.number().min(0).max(100),
    variantType1: nonEmpty,
    variantValue1: nonEmpty,
    variantType2: nonEmpty,
    variantValue2: nonEmpty,
    syncId: nonEmpty,
    skuImageSource: nonEmpty.optional(),
    skuImageLink: z.array(nonEmpty).optional(),
    sellingUnits: z.array(sellingUnitSchema).min(1),
})
    .superRefine((sku, ctx) => {
    const baseUnits = sku.sellingUnits.filter((u) => u.isBaseUnit);
    if (baseUnits.length !== 1) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sellingUnits"],
            message: "exactly one selling unit must have isBaseUnit=true",
        });
    }
    else if (baseUnits[0].multiplier !== 1) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sellingUnits"],
            message: "base selling unit must have multiplier=1",
        });
    }
});
export const itemSchema = z.object({
    itemName: nonEmpty,
    description: z.string().optional(),
    brandName: nonEmpty,
    categoryName: nonEmpty,
    subCategoryName: nonEmpty,
    syncId: nonEmpty,
    itemImageSource: nonEmpty.optional(),
    itemImageLink: z.array(nonEmpty).optional(),
    skus: z.array(skuSchema).min(1),
});
/**
 * Pre-flight validation mirroring Mulltiply's implementation checklist:
 * required fields, numeric prices/multipliers, and globally unique
 * item + SKU syncIds across the whole run.
 */
export function validateItems(items) {
    const valid = [];
    const invalid = [];
    const seenItemSyncIds = new Set();
    const seenSkuSyncIds = new Set();
    for (const item of items) {
        const errors = [];
        const parsed = itemSchema.safeParse(item);
        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                errors.push(`${issue.path.join(".")}: ${issue.message}`);
            }
        }
        if (item.syncId) {
            if (seenItemSyncIds.has(item.syncId)) {
                errors.push(`duplicate item syncId: ${item.syncId}`);
            }
            for (const sku of item.skus ?? []) {
                if (sku.syncId && seenSkuSyncIds.has(sku.syncId)) {
                    errors.push(`duplicate SKU syncId: ${sku.syncId}`);
                }
            }
        }
        if (errors.length > 0) {
            invalid.push({
                syncId: item.syncId ?? "",
                itemName: item.itemName ?? "",
                errors,
            });
            continue;
        }
        seenItemSyncIds.add(item.syncId);
        for (const sku of item.skus)
            seenSkuSyncIds.add(sku.syncId);
        valid.push(item);
    }
    return { valid, invalid };
}
//# sourceMappingURL=validate.js.map