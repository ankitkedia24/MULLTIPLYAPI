/** Row shape of AMITCLOUD's public.mulltiply_customer_feed view (PostgREST). */
export interface CustomerFeedRow {
  id: string;
  customer_code: string | null;
  customer_name: string | null;
  alias_name: string | null;
  email: string | null;
  gstin: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pin_code: string | null;
  country: string | null;
  /** First valid Indian mobile (10 digits) or null — picked in the ERP view. */
  mobile: string | null;
  last_sale_date: string | null;
  updated_at: string | null;
  changed_at: string | null;
  eligible: boolean;
}

/** Mulltiply Customer Sync payload shapes (POST /v2/retailers/sync-data). */
export interface MulltiplyAddress {
  syncId: string | null;
  address1: string;
  address2: string;
  city: string;
  province: string;
  provinceCode: string;
  country: string;
  countryCode: string;
  zip: string;
  phoneCountryCode: string;
  phone: string;
  company: string;
  firstName: string;
  lastName: string;
  isDefault: boolean;
  isBillingAddress: boolean;
  addressType?: "SHIPPING_ADDRESS";
}

export interface MulltiplyShop {
  syncId: string;
  customerSyncId: string;
  shopName: string;
  city: string;
  state: string;
  pincode: string;
  gstNumber?: string;
  isPrimary: boolean;
  shippingAddress: MulltiplyAddress;
}

export interface MulltiplyRetailer {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneCountryCode: string;
  phone: string;
  syncId: string;
  note: string;
  tags: string[];
  taxExempt: boolean;
  gstNumber?: string;
  billingAddress: MulltiplyAddress;
  shops: MulltiplyShop[];
}

/** Their documented response shape. */
export interface MulltiplyRetailerResponse {
  count?: number;
  message?: string;
  nonProcessableRows?: Array<{ row: number; errors: string[] }>;
}

export type CustomerTransformResult =
  | { status: "ok"; retailer: MulltiplyRetailer; warnings: string[] }
  | { status: "skip"; customerCode: string; customerName: string; reason: string };

export interface CustomerBatchResult {
  batchNo: number;
  rowCount: number;
  httpStatus: number | null;
  attempts: number;
  accepted: boolean;
  rowErrors: Array<{ syncId: string; customerName: string; errors: string[] }>;
  error?: string;
}

export type CustomerRunMode = "full" | "incremental";
export type CustomerRunStatus = "completed" | "completed_with_errors" | "failed";

/** Report written to data/customer-runs/run-<ts>.json after every run. */
export interface CustomerRunReport {
  runId: string;
  mode: CustomerRunMode;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: CustomerRunStatus;
  totals: {
    fetched: number;
    skipped: number;
    sent: number;
    accepted: number;
    rowErrors: number;
  };
  warningCounts: Record<string, number>;
  skipped: Array<{ customerCode: string; customerName: string; reason: string }>;
  batches: CustomerBatchResult[];
  fatalError?: string;
}
