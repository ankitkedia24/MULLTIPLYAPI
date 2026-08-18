/** Row shape fetched from AMITCLOUD's public.books via PostgREST. */
export interface BookRow {
  isbn: string | null;
  additional_book_code: string | null;
  book_name: string | null;
  short_description: string | null;
  author_name: string | null;
  publisher_name: string | null;
  category: string | null;
  sub_category: string | null;
  subject: string | null;
  class_name: string | null;
  binding: string | null;
  edition: string | null;
  language: string | null;
  cover_image_url: string | null;
  sale_rate: number | string | null;
  sale_retail_price: number | string | null;
  sale_net_price: number | string | null;
  sale_wholesale_price: number | string | null;
  closing_stock: number | string | null;
  is_active: boolean | null;
  updated_at: string | null;
}

/** Mulltiply Item Sync payload shapes (PUT /v2/items/sync-data). */
export interface MulltiplySellingUnit {
  name: string;
  multiplier: number;
  mrp: number;
  sellingPrice: number;
  availableQuantity?: number;
  isBaseUnit: boolean;
  isDefault: boolean;
  includeGST: boolean;
  /** Required on every unit — their inventory-sync API addresses units by it. */
  syncId: string;
  isActive: boolean;
}

export interface MulltiplySku {
  skuName: string;
  skuNickName: string;
  sellerSKU: string;
  tags: string[] | null;
  productCode: string;
  barCode: string | null;
  hsnCode: string;
  gst: number;
  variantType1: string;
  variantValue1: string;
  variantType2: string;
  variantValue2: string;
  syncId: string;
  skuImageSource?: string;
  skuImageLink?: string[];
  sellingUnits: MulltiplySellingUnit[];
}

export interface MulltiplyItem {
  itemName: string;
  description?: string;
  brandName: string;
  categoryName: string;
  subCategoryName: string;
  syncId: string;
  itemImageSource?: string;
  itemImageLink?: string[];
  skus: MulltiplySku[];
}

/** Mulltiply response envelope. */
export interface MulltiplyRowError {
  row: number;
  itemName: string;
  errors: string[];
}

export interface MulltiplyResponse {
  error: boolean;
  status: boolean;
  statusCode: number;
  responseTimestamp: string;
  data: {
    message: string;
    processedCount?: number;
    errorCount?: number;
    errors?: MulltiplyRowError[];
  };
}

/** Transform outcome for one book row. */
export type TransformResult =
  | { status: "ok"; item: MulltiplyItem; warnings: string[] }
  | { status: "skip"; isbn: string; bookName: string; reason: string };

/** One pushed batch's outcome. */
export interface BatchResult {
  batchNo: number;
  itemCount: number;
  httpStatus: number | null;
  attempts: number;
  accepted: boolean;
  rowErrors: Array<{ isbn: string; itemName: string; errors: string[] }>;
  error?: string;
}

export type RunMode = "full" | "incremental";
export type RunStatus = "completed" | "completed_with_errors" | "failed";

/** Report written to data/runs/run-<ts>.json after every run. */
export interface RunReport {
  runId: string;
  mode: RunMode;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: RunStatus;
  totals: {
    fetched: number;
    skipped: number;
    invalid: number;
    sent: number;
    accepted: number;
    rowErrors: number;
  };
  warningCounts: Record<string, number>;
  skipped: Array<{ isbn: string; bookName: string; reason: string }>;
  invalid: Array<{ syncId: string; itemName: string; errors: string[] }>;
  batches: BatchResult[];
  fatalError?: string;
}

/** Persisted watermark state (data/state.json). */
export interface SyncState {
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastRun: {
    runId: string;
    mode: RunMode;
    status: RunStatus;
    finishedAt: string;
    totals: RunReport["totals"];
  } | null;
}
