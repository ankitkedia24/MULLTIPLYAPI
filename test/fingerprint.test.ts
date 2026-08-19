import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeFingerprint,
  loadFingerprints,
  saveFingerprints,
} from "../src/fingerprint.js";
import { bookToItem } from "../src/transform.js";
import type { BookRow } from "../src/types.js";
import { makeTestConfig } from "./helpers.js";

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "books.json"), "utf8"),
) as BookRow[];
const cfg = makeTestConfig();

function itemFor(row: BookRow) {
  const r = bookToItem(row, cfg);
  if (r.status !== "ok") throw new Error("fixture should transform");
  return r.item;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("computeFingerprint", () => {
  it("ignores stock quantity but not master data", () => {
    const base = fixtures[0]!;
    const fpBase = computeFingerprint(itemFor(base));

    // same book, different stock → SAME fingerprint (routes as stock-only)
    const restocked = { ...base, closing_stock: 999 };
    expect(computeFingerprint(itemFor(restocked))).toBe(fpBase);

    // price change → different fingerprint (routes as item-sync)
    const repriced = { ...base, sale_rate: 999.5 };
    expect(computeFingerprint(itemFor(repriced))).not.toBe(fpBase);

    // name change → different fingerprint
    const renamed = { ...base, book_name: "Renamed Title" };
    expect(computeFingerprint(itemFor(renamed))).not.toBe(fpBase);
  });

  it("round-trips through save/load, and missing file loads empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-test-"));
    tempDirs.push(dir);

    expect(await loadFingerprints(dir)).toEqual({});
    const map = { A: "1".repeat(32), B: "2".repeat(32) };
    await saveFingerprints(dir, map);
    expect(await loadFingerprints(dir)).toEqual(map);
  });
});
