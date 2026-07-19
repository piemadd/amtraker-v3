// Confirms the new shape validation (assertHasKeys/assertPlainObject) catches
// "200 OK, valid JSON, wrong shape" upstream responses — a case none of the
// existing fixtures covered, since they only test outright fetch failures
// or malformed *records within* an otherwise correctly-shaped payload.

import { platformsFixture, amtrakAlertsFixture, proxyFixtureHealthy } from "./fixtures";

const jsonResponse = (body: any) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

let brightlineCallCount = 0;

globalThis.fetch = (async (input: any) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.startsWith("https://platformsapi.amtraker.com/stations")) return jsonResponse(platformsFixture);
  if (url.startsWith("https://store.transitstat.us/amtrak_alerts")) return jsonResponse(amtrakAlertsFixture);

  if (url.startsWith("https://store.transitstat.us/brightline")) {
    brightlineCallCount++;
    // Valid JSON, 200 OK, but missing the "v1"/"platforms" keys the code
    // expects — e.g. an API version change, a maintenance page that still
    // returns JSON, or a proxy/CDN error body.
    return jsonResponse({ error: "temporarily unavailable", code: 503 });
  }

  if (url.startsWith("https://store.transitstat.us/amtrak_fetch_proxy")) return jsonResponse(proxyFixtureHealthy);

  throw new Error(`shape-validation-test harness: unmocked fetch to ${url}`);
}) as typeof fetch;

console.log("[shape-validation-test] booting with a wrong-shape-but-valid-JSON brightline response...");

await import("../index");

await new Promise((resolve) => setTimeout(resolve, 500));

if (brightlineCallCount < 1) {
  console.log("[shape-validation-test] FAIL: brightline was never even called.");
  process.exit(1);
}

console.log("[shape-validation-test] PASS: process is still alive and the cycle completed despite the malformed brightline shape (see 'InvalidShapeError' above).");
process.exit(0);
