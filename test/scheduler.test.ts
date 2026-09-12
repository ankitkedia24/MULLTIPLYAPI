import { describe, expect, it } from "vitest";
import { nextFullSyncAt } from "../src/scheduler.js";

// Local-time dates: the scheduler works in server local time (TZ on the host).
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

describe("nextFullSyncAt", () => {
  it("weekly: Sunday 02:00 after a Saturday evening", () => {
    // 12-09-2026 is a Saturday.
    const next = nextFullSyncAt({ SYNC_FULL_HOUR: 2, SYNC_FULL_WEEKDAY: 0 }, at(2026, 9, 12, 18));
    expect(next.getTime()).toBe(at(2026, 9, 13, 2).getTime());
    expect(next.getDay()).toBe(0);
  });

  it("weekly: a Sunday morning after 02:00 waits a full week", () => {
    const next = nextFullSyncAt({ SYNC_FULL_HOUR: 2, SYNC_FULL_WEEKDAY: 0 }, at(2026, 9, 13, 9));
    expect(next.getTime()).toBe(at(2026, 9, 20, 2).getTime());
  });

  it("weekly: Sunday 01:30 fires at 02:00 the same day", () => {
    const next = nextFullSyncAt({ SYNC_FULL_HOUR: 2, SYNC_FULL_WEEKDAY: 0 }, at(2026, 9, 13, 1, 30));
    expect(next.getTime()).toBe(at(2026, 9, 13, 2).getTime());
  });

  it("weekly: another weekday (Wednesday = 3)", () => {
    const next = nextFullSyncAt({ SYNC_FULL_HOUR: 2, SYNC_FULL_WEEKDAY: 3 }, at(2026, 9, 12, 18));
    expect(next.getTime()).toBe(at(2026, 9, 16, 2).getTime());
  });

  it("daily keeps the old nightly behaviour", () => {
    const next = nextFullSyncAt({ SYNC_FULL_HOUR: 2, SYNC_FULL_WEEKDAY: "daily" }, at(2026, 9, 12, 18));
    expect(next.getTime()).toBe(at(2026, 9, 13, 2).getTime());
    const next2 = nextFullSyncAt({ SYNC_FULL_HOUR: 2, SYNC_FULL_WEEKDAY: "daily" }, at(2026, 9, 13, 9));
    expect(next2.getTime()).toBe(at(2026, 9, 14, 2).getTime());
  });
});
