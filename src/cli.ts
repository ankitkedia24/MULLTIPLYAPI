import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { runSync } from "./sync.js";

const { values } = parseArgs({
  options: {
    full: { type: "boolean", default: false },
    incremental: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    isbn: { type: "string" },
    limit: { type: "string" },
    since: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help || (!values.full && !values.incremental && !values.isbn)) {
  console.log(`Mulltiply Item Sync CLI

Usage:
  npm run sync:full                 full sync of all books
  npm run sync:incr                 incremental sync (books changed since last run)
  npm run preview                   dry-run of 5 books, nothing sent

  npx tsx src/cli.ts --full [--dry-run] [--limit N]
  npx tsx src/cli.ts --incremental [--since 2026-08-01T00:00:00Z]
  npx tsx src/cli.ts --isbn 9781234567890 [--dry-run]
`);
  process.exit(values.help ? 0 : 2);
}

const cfg = loadConfig();
const mode = values.incremental ? "incremental" : "full";

const report = await runSync(cfg, {
  mode,
  dryRun: values["dry-run"],
  isbn: values.isbn,
  limit: values.limit ? Number(values.limit) : undefined,
  since: values.since,
});

// let the event loop drain naturally (process.exit here trips a libuv
// assertion on Windows while undici sockets are still closing)
process.exitCode = report.status === "failed" ? 1 : 0;
