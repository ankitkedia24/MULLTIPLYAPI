import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncState } from "./types.js";

const EMPTY_STATE: SyncState = {
  lastSyncAt: null,
  lastFullSyncAt: null,
  lastRun: null,
};

function statePath(dataDir: string): string {
  return join(dataDir, "state.json");
}

/** Unreadable/corrupt state is treated as never-synced (forces a full sync). */
export async function readState(dataDir: string): Promise<SyncState> {
  try {
    const raw = await readFile(statePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Atomic write: temp file then rename, so a crash never corrupts state. */
export async function writeState(dataDir: string, state: SyncState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = statePath(dataDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, target);
}
