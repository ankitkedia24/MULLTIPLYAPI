import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
function fpPath(dataDir) {
    return join(dataDir, "fingerprints.json");
}
/**
 * Hash of an item's master data — everything EXCEPT stock quantity. Two
 * transforms of the same book differing only in closing_stock produce the
 * same fingerprint, which is what routes that change to the lightweight
 * inventory API instead of a full item-sync.
 */
export function computeFingerprint(item) {
    const withoutStock = {
        ...item,
        skus: item.skus.map((sku) => ({
            ...sku,
            sellingUnits: sku.sellingUnits.map(({ availableQuantity: _qty, ...rest }) => rest),
        })),
    };
    return createHash("sha256")
        .update(JSON.stringify(withoutStock))
        .digest("hex")
        .slice(0, 32);
}
/** Unreadable/corrupt file → empty map (every book routes as item-sync). */
export async function loadFingerprints(dataDir) {
    try {
        const parsed = JSON.parse(await readFile(fpPath(dataDir), "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
/** Atomic write, same tmp+rename pattern as state.json. */
export async function saveFingerprints(dataDir, map) {
    await mkdir(dataDir, { recursive: true });
    const target = fpPath(dataDir);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(map), "utf8");
    await rename(tmp, target);
}
//# sourceMappingURL=fingerprint.js.map