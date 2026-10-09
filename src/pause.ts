import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A timed hold on all automatic syncs (items + customers). Lives in its own
 * file in DATA_DIR — not state.json — so a run's read-modify-write of the
 * state can never overwrite it, and it survives deploys. It expires on its
 * own: once `until` passes, the scheduler simply resumes.
 */
export interface PauseRecord {
  until: string;
  setAt: string;
  reason?: string;
}

function pausePath(dataDir: string): string {
  return join(dataDir, "pause.json");
}

export async function readPause(dataDir: string): Promise<PauseRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(pausePath(dataDir), "utf8")) as PauseRecord;
    return parsed && typeof parsed.until === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** The active pause, or null when there is none or it has already expired. */
export async function activePause(
  dataDir: string,
  now: Date = new Date(),
): Promise<PauseRecord | null> {
  const pause = await readPause(dataDir);
  if (!pause) return null;
  const until = new Date(pause.until).getTime();
  return Number.isFinite(until) && until > now.getTime() ? pause : null;
}

export async function writePause(dataDir: string, pause: PauseRecord): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = pausePath(dataDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(pause, null, 2), "utf8");
  await rename(tmp, target);
}

export async function clearPause(dataDir: string): Promise<void> {
  await rm(pausePath(dataDir), { force: true });
}
