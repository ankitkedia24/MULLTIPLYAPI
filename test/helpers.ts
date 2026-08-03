import { loadConfig, type Config } from "../src/config.js";

/** Config for tests — valid dummy Supabase creds, tiny batches, fast retries. */
export function makeTestConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test_key_not_real",
    MULLTIPLY_BASE_URL: "http://localhost:4010",
    MULLTIPLY_API_KEY: "test-key",
    ADMIN_API_KEY: "admin-test-key",
    SYNC_BATCH_SIZE: "4",
    SYNC_BATCH_DELAY_MS: "0",
    SYNC_MAX_RETRIES: "2",
    SYNC_SCHEDULE_ENABLED: "false",
    DATA_DIR: "./data-test",
    ...overrides,
  });
}
