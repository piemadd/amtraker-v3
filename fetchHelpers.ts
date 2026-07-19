// Fetch helpers extracted so they can be unit tested independently of the
// server: per-request timeout (an upstream hang shouldn't be able to block
// the update cycle indefinitely), retry-with-backoff before giving up and
// falling back to last-known-good data, and minimal shape validation so a
// 200 response with the wrong JSON shape is treated as a failure rather than
// silently flowing into the parsing logic below.

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
  }
}

export class InvalidShapeError extends Error {
  constructor(label: string, detail: string) {
    super(`${label}: response failed shape validation — ${detail}`);
    this.name = "InvalidShapeError";
  }
}

export const fetchWithTimeout = async (
  url: string,
  timeoutMs: number,
  options?: RequestInit
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

export interface RetryOptions {
  timeoutMs: number;
  retries: number; // number of RETRIES after the first attempt (0 = no retry)
  backoffMs: number; // base backoff, multiplied by attempt number
}

// Fetches and parses JSON, retrying on any failure (timeout, network error,
// or non-2xx) up to `retries` times with linear backoff, before finally
// throwing. Callers already have last-known-good fallback logic around this
// — this only controls how hard we try before giving up on the live fetch.
export const fetchJSONWithRetry = async (
  url: string,
  opts: RetryOptions
): Promise<any> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts.timeoutMs);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < opts.retries) {
        await new Promise((resolve) => setTimeout(resolve, opts.backoffMs * (attempt + 1)));
      }
    }
  }
  throw lastErr;
};

// Minimal shape checks — not a full schema validator, just enough to catch
// "valid JSON, wrong shape" (e.g. an error page's JSON body, or a feed
// returning an array where an object was expected) before it reaches the
// parsing logic below, which assumes the shape is correct.
export const assertPlainObject = (value: any, label: string): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidShapeError(label, `expected a plain object, got ${Array.isArray(value) ? "an array" : typeof value}`);
  }
};

export const assertHasKeys = (value: any, keys: string[], label: string): void => {
  assertPlainObject(value, label);
  const missing = keys.filter((k) => !(k in value));
  if (missing.length > 0) {
    throw new InvalidShapeError(label, `missing expected key(s): ${missing.join(", ")}`);
  }
};
