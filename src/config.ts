import { z } from "zod";

const PRICE_FIELDS = [
  "sale_rate",
  "sale_retail_price",
  "sale_net_price",
  "sale_wholesale_price",
] as const;

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  MULLTIPLY_BASE_URL: z.string().url().default("http://localhost:4010"),
  MULLTIPLY_API_KEY: z.string().default(""),

  ADMIN_API_KEY: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(3000),

  SYNC_HSN_CODE: z.string().default("4901"),
  SYNC_GST_PERCENT: z.coerce.number().min(0).max(100).default(0),
  SYNC_UNIT_NAME: z.string().default("PCS"),
  SYNC_PRICE_FIELD: z.enum(PRICE_FIELDS).default("sale_rate"),
  SYNC_BOOK_FILTER: z.enum(["active", "in_stock"]).default("active"),
  SYNC_VARIANT_TYPE1: z.string().default("Binding"),
  SYNC_VARIANT_TYPE2: z.string().default("Language"),
  SYNC_CATEGORY_FALLBACK: z.string().default("BOOKS"),
  SYNC_SUBCATEGORY_FALLBACK: z.string().default("GENERAL"),

  SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(300),
  SYNC_BATCH_DELAY_MS: z.coerce.number().int().min(0).default(500),
  SYNC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),

  /** Look-back window (minutes) for incremental runs when no watermark exists. */
  SYNC_INCR_WINDOW_MINUTES: z.coerce.number().int().min(5).default(60),

  /** Route stock-only changes through Mulltiply's inventory API (Phase 2). */
  SYNC_STOCK_API_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  SYNC_STOCK_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  /** Their inventory API expects syncIds as "<prefix><unitSyncId>". */
  SYNC_STOCK_SYNCID_PREFIX: z.string().default("external://variant/"),

  SYNC_SCHEDULE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  SYNC_FULL_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  // Mulltiply asked (12-09-2026) for the complete catalogue once a WEEK, not
  // every night; the 30-minute incrementals carry everything in between.
  // 0 = Sunday … 6 = Saturday, in server local time (TZ=Asia/Kolkata on the
  // host). Set to "daily" to get the old nightly behaviour back.
  SYNC_FULL_WEEKDAY: z
    .string()
    .default("0")
    .transform((v) => (v.trim().toLowerCase() === "daily" ? "daily" : Number(v)))
    .refine((v) => v === "daily" || (Number.isInteger(v) && v >= 0 && v <= 6), {
      message: "SYNC_FULL_WEEKDAY must be 0–6 (0 = Sunday) or daily",
    }),
  SYNC_INCR_MINUTES: z.coerce.number().int().min(0).default(30),

  DATA_DIR: z.string().default("./data"),

  // Customer (retailer) sync — POST /v2/retailers/sync-data, added 12-09-2026.
  // Rides the same schedule as items: weekly full (right after the item full),
  // incremental every SYNC_INCR_MINUTES. Off-switch for the whole pipeline.
  CUSTOMER_SYNC_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  CUSTOMER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
});

export type Config = z.infer<typeof envSchema>;
export type PriceField = (typeof PRICE_FIELDS)[number];

/** Load .env (if present) and parse config, failing fast with readable errors. */
export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env file — rely on real environment variables (e.g. hosting panel)
  }
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return parsed.data;
}
