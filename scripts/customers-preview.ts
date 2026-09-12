// Dry preview of the whole customer feed: totals, warning/skip profile, one payload.
import { loadConfig } from "../src/config.js";
import { fetchCustomers } from "../src/customers/feed.js";
import { customerToRetailer } from "../src/customers/transform.js";
const cfg = loadConfig();
const rows = await fetchCustomers(cfg, {});
const results = rows.map((x) => customerToRetailer(x, cfg));
const ok = results.filter((x) => x.status === "ok");
const skip = results.filter((x) => x.status === "skip");
const warn: Record<string, number> = {};
for (const x of ok) if (x.status === "ok") for (const w of x.warnings) warn[w] = (warn[w] ?? 0) + 1;
const skipReasons: Record<string, number> = {};
for (const s of skip) if (s.status === "skip") skipReasons[s.reason] = (skipReasons[s.reason] ?? 0) + 1;
console.log(JSON.stringify({ fetched: rows.length, ok: ok.length, skipped: skip.length, warnings: warn, skipReasons }));
const sample = ok.find((x) => x.status === "ok" && x.retailer.gstNumber) ?? ok[0];
if (sample && sample.status === "ok") console.log(JSON.stringify(sample.retailer, null, 1));
