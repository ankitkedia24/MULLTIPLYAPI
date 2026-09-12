import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const EMPTY_STATE = {
    lastSyncAt: null,
    lastFullSyncAt: null,
    lastRun: null,
};
function statePath(dataDir) {
    return join(dataDir, "state.json");
}
/** Unreadable/corrupt state is treated as never-synced (forces a full sync). */
export async function readState(dataDir) {
    try {
        const raw = await readFile(statePath(dataDir), "utf8");
        const parsed = JSON.parse(raw);
        return { ...EMPTY_STATE, ...parsed };
    }
    catch {
        return { ...EMPTY_STATE };
    }
}
/** Atomic write: temp file then rename, so a crash never corrupts state. */
export async function writeState(dataDir, state) {
    await mkdir(dataDir, { recursive: true });
    const target = statePath(dataDir);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, target);
}
//# sourceMappingURL=state.js.map