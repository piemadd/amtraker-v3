// Integration test for the updateInProgress overlap guard.
//
// index.ts calls safeUpdateTrains() once at import time, then registers
// setInterval(() => safeUpdateTrains(), 1000 * 15). To actually observe
// overlapping ticks without waiting 15 real seconds, this test overrides
// globalThis.setInterval BEFORE importing index.ts so that whatever interval
// index.ts asks for is compressed to a few milliseconds instead. The mocked
// proxy fetch is made deliberately slow (350ms) so multiple compressed
// "15s" ticks land while the first run is still in flight — exactly the
// overlap scenario the guard exists for.

import { platformsFixture, amtrakAlertsFixture, brightlineFixture, proxyFixtureHealthy } from "./fixtures";

let proxyFetchCallCount = 0;
let concurrentProxyFetches = 0;
let maxObservedConcurrency = 0;

const jsonResponse = (body: any) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: any) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.startsWith("https://platformsapi.amtraker.com/stations")) return jsonResponse(platformsFixture);
  if (url.startsWith("https://store.transitstat.us/amtrak_alerts")) return jsonResponse(amtrakAlertsFixture);
  if (url.startsWith("https://store.transitstat.us/brightline")) return jsonResponse(brightlineFixture);

  if (url.startsWith("https://store.transitstat.us/amtrak_fetch_proxy")) {
    proxyFetchCallCount++;
    concurrentProxyFetches++;
    maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrentProxyFetches);
    await new Promise((resolve) => setTimeout(resolve, 350)); // deliberately slow
    concurrentProxyFetches--;
    return jsonResponse(proxyFixtureHealthy);
  }

  throw new Error(`overlap-test harness: unmocked fetch to ${url}`);
}) as typeof fetch;

// Compress whatever interval index.ts requests down to 40ms, so several
// ticks land inside one 350ms-slow cycle.
const realSetInterval = globalThis.setInterval;
(globalThis as any).setInterval = (fn: any, _ms?: number) => realSetInterval(fn, 40);

console.log("[overlap-test] booting patched server with a slow proxy feed and a compressed tick interval...");

await import("../index");

// Let several compressed ticks land while the first (350ms) cycle is still running.
await new Promise((resolve) => setTimeout(resolve, 900));

console.log(`[overlap-test] proxy fetch was actually called ${proxyFetchCallCount} time(s) during the window.`);
console.log(`[overlap-test] max concurrent proxy fetches observed: ${maxObservedConcurrency}`);

if (maxObservedConcurrency > 1) {
  console.log("[overlap-test] FAIL: more than one update cycle ran concurrently — overlap guard did not hold.");
  process.exit(1);
}

if (proxyFetchCallCount < 2) {
  console.log("[overlap-test] FAIL: expected at least 2 sequential cycles to have run in the test window.");
  process.exit(1);
}

console.log("[overlap-test] PASS: ticks were serialized — no more than 1 update cycle in flight at a time.");
process.exit(0);
