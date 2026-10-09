import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
function pausePath(dataDir) {
    return join(dataDir, "pause.json");
}
export async function readPause(dataDir) {
    try {
        const parsed = JSON.parse(await readFile(pausePath(dataDir), "utf8"));
        return parsed && typeof parsed.until === "string" ? parsed : null;
    }
    catch {
        return null;
    }
}
/** The active pause, or null when there is none or it has already expired. */
export async function activePause(dataDir, now = new Date()) {
    const pause = await readPause(dataDir);
    if (!pause)
        return null;
    const until = new Date(pause.until).getTime();
    return Number.isFinite(until) && until > now.getTime() ? pause : null;
}
export async function writePause(dataDir, pause) {
    await mkdir(dataDir, { recursive: true });
    const target = pausePath(dataDir);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(pause, null, 2), "utf8");
    await rename(tmp, target);
}
export async function clearPause(dataDir) {
    await rm(pausePath(dataDir), { force: true });
}
//# sourceMappingURL=pause.js.map