import type { Config } from "./config.js";
import type { BookRow, MulltiplyItem, TransformResult } from "./types.js";

/** Trim and collapse internal whitespace runs to single spaces. */
function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const SKU_NICKNAME_MAX = 60;

/** Strip Excel text-marker artifacts (leading/trailing backticks, quotes). */
function cleanCode(value: string | null | undefined): string {
  return clean(value).replace(/^[`'"]+/, "").replace(/[`'"]+$/, "");
}

/** ISBN-13 (978…) or ISBN-10 — only these become scannable barcodes. */
function isIsbnLike(code: string): boolean {
  return /^\d{13}$/.test(code) || /^\d{9}[\dXx]$/.test(code);
}

/**
 * Map one ERP book row to one Mulltiply item (single SKU, single base
 * selling unit — books have no size/colour variants). Pure function.
 */
export function bookToItem(row: BookRow, cfg: Config): TransformResult {
  const isbn = cleanCode(row.isbn);
  const bookName = clean(row.book_name);

  if (!isbn) {
    return { status: "skip", isbn: "", bookName, reason: "missing isbn" };
  }
  if (!bookName) {
    return { status: "skip", isbn, bookName: "", reason: "missing book_name" };
  }

  const mrp = toNumber(row.sale_rate);
  if (mrp === null || mrp <= 0) {
    return { status: "skip", isbn, bookName, reason: "sale_rate missing or not > 0" };
  }

  const sellingPrice = toNumber(row[cfg.SYNC_PRICE_FIELD]) ?? mrp;
  if (sellingPrice <= 0) {
    return {
      status: "skip",
      isbn,
      bookName,
      reason: `${cfg.SYNC_PRICE_FIELD} not > 0`,
    };
  }

  const warnings: string[] = [];

  const category = clean(row.category) || clean(row.subject);
  const categoryName = category || cfg.SYNC_CATEGORY_FALLBACK;
  if (!category) warnings.push("category_fallback");

  const subCategory = clean(row.sub_category) || clean(row.class_name);
  const subCategoryName = subCategory || cfg.SYNC_SUBCATEGORY_FALLBACK;
  if (!subCategory) warnings.push("sub_category_fallback");

  const binding = clean(row.binding) || "PB";
  if (!clean(row.binding)) warnings.push("binding_defaulted");
  const language = clean(row.language) || "English";
  if (!clean(row.language)) warnings.push("language_defaulted");

  const author = clean(row.author_name);
  const publisher = clean(row.publisher_name);
  if (!publisher) {
    return { status: "skip", isbn, bookName, reason: "missing publisher_name" };
  }

  const edition = clean(row.edition);
  const description =
    clean(row.short_description) ||
    [author, publisher, edition].filter(Boolean).join(" | ") ||
    bookName;

  const stock = toNumber(row.closing_stock) ?? 0;
  const availableQuantity = Math.max(0, Math.trunc(stock));
  if (stock < 0) warnings.push("negative_stock_clamped");

  const imageUrl = clean(row.cover_image_url);
  const image = imageUrl
    ? { source: "OTHERS", links: [imageUrl] }
    : null;

  const skuNickName =
    bookName.length > SKU_NICKNAME_MAX
      ? bookName.slice(0, SKU_NICKNAME_MAX).trimEnd()
      : bookName;

  const item: MulltiplyItem = {
    itemName: bookName,
    description,
    brandName: publisher,
    categoryName,
    subCategoryName,
    syncId: isbn,
    ...(image ? { itemImageSource: image.source, itemImageLink: image.links } : {}),
    skus: [
      {
        skuName: bookName,
        skuNickName,
        sellerSKU: isbn,
        tags: null,
        productCode: isbn,
        barCode: isIsbnLike(isbn) ? isbn : null,
        hsnCode: cfg.SYNC_HSN_CODE,
        gst: cfg.SYNC_GST_PERCENT,
        variantType1: cfg.SYNC_VARIANT_TYPE1,
        variantValue1: binding,
        variantType2: cfg.SYNC_VARIANT_TYPE2,
        variantValue2: language,
        syncId: isbn,
        ...(image ? { skuImageSource: image.source, skuImageLink: image.links } : {}),
        sellingUnits: [
          {
            name: cfg.SYNC_UNIT_NAME,
            multiplier: 1,
            mrp,
            sellingPrice,
            availableQuantity,
            isBaseUnit: true,
            isDefault: true,
            includeGST: true,
            isActive: true,
          },
        ],
      },
    ],
  };

  return { status: "ok", item, warnings };
}
