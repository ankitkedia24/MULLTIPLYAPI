import { describe, expect, it } from "vitest";
import { MulltiplyAuthError, pushBatch } from "../src/mulltiply-client.js";
import type { MulltiplyItem, MulltiplyResponse } from "../src/types.js";
import { makeTestConfig } from "./helpers.js";

const cfg = makeTestConfig();

function item(syncId: string): MulltiplyItem {
  return {
    itemName: `Book ${syncId}`,
    brandName: "PUB",
    categoryName: "BOOKS",
    subCategoryName: "GENERAL",
    syncId,
    skus: [],
  } as unknown as MulltiplyItem;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function successEnvelope(): MulltiplyResponse {
  return {
    error: false,
    status: true,
    statusCode: 200,
    responseTimestamp: new Date().toISOString(),
    data: { message: "All rows processed successfully" },
  };
}

describe("pushBatch", () => {
  it("returns accepted with no row errors on success", async () => {
    const result = await pushBatch([item("A")], 1, cfg, async () =>
      jsonResponse(200, successEnvelope()),
    );
    expect(result.accepted).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.rowErrors).toEqual([]);
  });

  it("sends the right method, headers and array body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    await pushBatch([item("A"), item("B")], 1, cfg, async (url, init) => {
      captured = { url: String(url), init: init! };
      return jsonResponse(200, successEnvelope());
    });
    expect(captured!.url).toBe("http://localhost:4010/v2/items/sync-data");
    expect(captured!.init.method).toBe("PUT");
    expect((captured!.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const body = JSON.parse(String(captured!.init.body));
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("maps partial-failure row errors back to ISBNs (0-based and 1-based)", async () => {
    const items = [item("ISBN-0"), item("ISBN-1"), item("ISBN-2")];
    const envelope: MulltiplyResponse = {
      ...successEnvelope(),
      data: {
        message: "Some rows failed",
        processedCount: 2,
        errorCount: 1,
        // 1-based row pointing at items[0] — mapper must fall back correctly
        errors: [{ row: 1, itemName: "Book ISBN-0", errors: ["bad data"] }],
      },
    };
    const result = await pushBatch(items, 1, cfg, async () => jsonResponse(200, envelope));
    expect(result.accepted).toBe(true);
    expect(result.rowErrors).toEqual([
      { isbn: "ISBN-0", itemName: "Book ISBN-0", errors: ["bad data"] },
    ]);
  });

  it("throws MulltiplyAuthError on 401 without retrying", async () => {
    let calls = 0;
    await expect(
      pushBatch([item("A")], 1, cfg, async () => {
        calls++;
        return jsonResponse(401, { message: "bad key" });
      }),
    ).rejects.toThrow(MulltiplyAuthError);
    expect(calls).toBe(1);
  });

  it("retries 500s and succeeds", { timeout: 15000 }, async () => {
    let calls = 0;
    const result = await pushBatch([item("A")], 1, cfg, async () => {
      calls++;
      return calls === 1
        ? jsonResponse(500, { message: "boom" })
        : jsonResponse(200, successEnvelope());
    });
    expect(result.accepted).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("honors Retry-After on 429", { timeout: 15000 }, async () => {
    let calls = 0;
    const started = Date.now();
    const result = await pushBatch([item("A")], 1, cfg, async () => {
      calls++;
      return calls === 1
        ? jsonResponse(429, { message: "slow down" }, { "retry-after": "1" })
        : jsonResponse(200, successEnvelope());
    });
    expect(result.accepted).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("recovers from a network error", { timeout: 15000 }, async () => {
    let calls = 0;
    const result = await pushBatch([item("A")], 1, cfg, async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return jsonResponse(200, successEnvelope());
    });
    expect(result.accepted).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("gives up after max retries on persistent 500s", { timeout: 30000 }, async () => {
    const result = await pushBatch([item("A")], 1, cfg, async () =>
      jsonResponse(500, { message: "always broken" }),
    );
    expect(result.accepted).toBe(false);
    expect(result.attempts).toBe(cfg.SYNC_MAX_RETRIES + 1);
    expect(result.error).toContain("gave up");
  });

  it("records other 4xx as a failed batch without throwing", async () => {
    const result = await pushBatch([item("A")], 1, cfg, async () =>
      jsonResponse(422, { message: "unprocessable" }),
    );
    expect(result.accepted).toBe(false);
    expect(result.httpStatus).toBe(422);
    expect(result.error).toContain("422");
  });
});
