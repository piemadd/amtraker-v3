import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  fetchWithTimeout,
  fetchJSONWithRetry,
  assertPlainObject,
  assertHasKeys,
  FetchTimeoutError,
  InvalidShapeError
} from "./fetchHelpers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchWithTimeout", () => {
  test("resolves normally when the request finishes before the timeout", async () => {
    globalThis.fetch = (async () => new Response("ok")) as any;
    const res = await fetchWithTimeout("https://example.com", 1000);
    expect(await res.text()).toBe("ok");
  });

  test("throws FetchTimeoutError when the request hangs past the timeout", async () => {
    globalThis.fetch = (async (_url: any, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as any;

    await expect(fetchWithTimeout("https://example.com/slow", 20)).rejects.toBeInstanceOf(FetchTimeoutError);
  });
});

describe("fetchJSONWithRetry", () => {
  test("returns parsed JSON on first success, no retry needed", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true }));
    }) as any;

    const data = await fetchJSONWithRetry("https://example.com", { timeoutMs: 1000, retries: 2, backoffMs: 1 });
    expect(data).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("retries on failure and succeeds on a later attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error("network blip");
      return new Response(JSON.stringify({ ok: true }));
    }) as any;

    const data = await fetchJSONWithRetry("https://example.com", { timeoutMs: 1000, retries: 2, backoffMs: 1 });
    expect(data).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  test("throws after exhausting all retries", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("upstream down");
    }) as any;

    await expect(
      fetchJSONWithRetry("https://example.com", { timeoutMs: 1000, retries: 2, backoffMs: 1 })
    ).rejects.toThrow("upstream down");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  test("treats a non-2xx response as a failure that triggers retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
    }) as any;

    await expect(
      fetchJSONWithRetry("https://example.com", { timeoutMs: 1000, retries: 1, backoffMs: 1 })
    ).rejects.toThrow("500");
    expect(calls).toBe(2);
  });
});

describe("shape validation", () => {
  test("assertPlainObject accepts a plain object", () => {
    expect(() => assertPlainObject({ a: 1 }, "test")).not.toThrow();
  });

  test("assertPlainObject rejects an array", () => {
    expect(() => assertPlainObject([1, 2, 3], "test")).toThrow(InvalidShapeError);
  });

  test("assertPlainObject rejects null", () => {
    expect(() => assertPlainObject(null, "test")).toThrow(InvalidShapeError);
  });

  test("assertHasKeys passes when all keys present", () => {
    expect(() => assertHasKeys({ trains: {}, stations: {} }, ["trains", "stations"], "test")).not.toThrow();
  });

  test("assertHasKeys throws listing the missing key", () => {
    expect(() => assertHasKeys({ trains: {} }, ["trains", "stations"], "test")).toThrow(/stations/);
  });
});
