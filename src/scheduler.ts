import type { Config } from "./config.js";
import { SyncBusyError, runSync } from "./sync.js";

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * In-process scheduler: nightly FULL sync at SYNC_FULL_HOUR (server local
 * time) plus an INCREMENTAL sync every SYNC_INCR_MINUTES. A run that
 * overlaps an in-flight one is skipped, not queued.
 */
export function startScheduler(
  cfg: Config,
  log: (msg: string) => void = console.log,
): SchedulerHandle {
  let fullTimer: NodeJS.Timeout | null = null;
  let incrTimer: NodeJS.Timeout | null = null;

  const trigger = async (mode: "full" | "incremental") => {
    try {
      log(`[scheduler] starting ${mode} sync`);
      await runSync(cfg, { mode });
    } catch (err) {
      if (err instanceof SyncBusyError) {
        log(`[scheduler] skipped ${mode} sync — another run is in progress`);
      } else {
        log(`[scheduler] ${mode} sync failed: ${String(err)}`);
      }
    }
  };

  const scheduleNextFull = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(cfg.SYNC_FULL_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const waitMs = next.getTime() - now.getTime();
    log(`[scheduler] next full sync at ${next.toLocaleString()}`);
    fullTimer = setTimeout(async () => {
      await trigger("full");
      scheduleNextFull();
    }, waitMs);
  };

  scheduleNextFull();

  if (cfg.SYNC_INCR_MINUTES > 0) {
    log(`[scheduler] incremental sync every ${cfg.SYNC_INCR_MINUTES} min`);
    incrTimer = setInterval(
      () => void trigger("incremental"),
      cfg.SYNC_INCR_MINUTES * 60_000,
    );
  }

  return {
    stop: () => {
      if (fullTimer) clearTimeout(fullTimer);
      if (incrTimer) clearInterval(incrTimer);
    },
  };
}
