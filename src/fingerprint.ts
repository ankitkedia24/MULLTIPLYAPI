import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MulltiplyItem } from "./types.js";

/** isbn → master-data fingerprint of the last successfully item-synced state. */
export type FingerprintMap = Record<string, string>;

function fpPath(dataDir: string): string {
  return join(dataDir, "fingerprints.json");
}

/**
 * Hash of an item's master data — everything EXCEPT stock quantity. Two
 * transforms of the same book differing only in closing_stock produce the
 * same fingerprint, which is what routes that change to the lightweight
 * inventory API instead of a full item-sync.
 */
export function computeFingerprint(item: MulltiplyItem): string {
  const withoutStock = {
    ...item,
    skus: item.skus.map((sku) => ({
      ...sku,
      sellingUnits: sku.sellingUnits.map(
        ({ availableQuantity: _qty, ...rest }) => rest,
      ),
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(withoutStock))
    .digest("hex")
    .slice(0, 32);
}

/** Unreadable/corrupt file → empty map (every book routes as item-sync). */
export async function loadFingerprints(dataDir: string): Promise<FingerprintMap> {
  try {
    const parsed = JSON.parse(await readFile(fpPath(dataDir), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as FingerprintMap) : {};
  } catch {
    return {};
  }
}

/** Atomic write, same tmp+rename pattern as state.json. */
export async function saveFingerprints(
  dataDir: string,
  map: FingerprintMap,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = fpPath(dataDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(map), "utf8");
  await rename(tmp, target);
}
