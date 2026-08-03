import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "./types.js";

function runsDir(dataDir: string): string {
  return join(dataDir, "runs");
}

export async function writeReport(dataDir: string, report: RunReport): Promise<string> {
  const dir = runsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `run-${report.runId}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}

export async function readLatestReport(dataDir: string): Promise<RunReport | null> {
  try {
    const files = (await readdir(runsDir(dataDir)))
      .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
      .sort();
    const latest = files.at(-1);
    if (!latest) return null;
    const raw = await readFile(join(runsDir(dataDir), latest), "utf8");
    return JSON.parse(raw) as RunReport;
  } catch {
    return null;
  }
}

/** Human-readable one-screen summary for CLI output and logs. */
export function formatSummary(report: RunReport): string {
  const t = report.totals;
  const lines = [
    `Run ${report.runId} (${report.mode}${report.dryRun ? ", DRY RUN" : ""}) — ${report.status}`,
    `  Duration : ${(report.durationMs / 1000).toFixed(1)}s`,
    `  Fetched  : ${t.fetched}`,
    `  Skipped  : ${t.skipped}`,
    `  Invalid  : ${t.invalid}`,
    `  Sent     : ${t.sent} (${report.batches.length} batches, ${t.accepted} accepted)`,
    `  RowErrors: ${t.rowErrors}`,
  ];
  const warnings = Object.entries(report.warningCounts);
  if (warnings.length > 0) {
    lines.push(
      `  Warnings : ${warnings.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }
  if (report.fatalError) lines.push(`  FATAL    : ${report.fatalError}`);
  return lines.join("\n");
}
