import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activePause, clearPause, readPause, writePause } from "../src/pause.js";

const dirs: string[] = [];
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "pause-test-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("pause", () => {
  it("is active before `until` and expires on its own after", async () => {
    const dir = await tempDir();
    const until = "2026-10-10T05:30:00.000Z"; // 11:00 IST
    await writePause(dir, { until, setAt: "2026-10-09T16:30:00.000Z" });

    expect((await activePause(dir, new Date("2026-10-10T05:29:59Z")))?.until).toBe(until);
    expect(await activePause(dir, new Date("2026-10-10T05:30:00Z"))).toBeNull();
    // the expired record stays on disk but no longer pauses anything
    expect((await readPause(dir))?.until).toBe(until);
  });

  it("missing, corrupt or cleared files mean not paused", async () => {
    const dir = await tempDir();
    expect(await activePause(dir)).toBeNull();

    await writeFile(join(dir, "pause.json"), "{not json", "utf8");
    expect(await activePause(dir)).toBeNull();

    await writePause(dir, { until: "2099-01-01T00:00:00.000Z", setAt: "2026-10-09T00:00:00.000Z" });
    expect(await activePause(dir)).not.toBeNull();
    await clearPause(dir);
    expect(await activePause(dir)).toBeNull();
  });
});
