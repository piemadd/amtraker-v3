import { test, expect, beforeEach } from "bun:test";
import {
  endpointHealth,
  markEndpointSuccess,
  markEndpointFailure,
  getEndpointHealthSnapshot,
  getShitsFucked,
  staleData,
  providerStaleData,
  resetCycleStaleness,
  finalizeStaleness,
  getServedStaleData,
  getServedProviderStaleData,
  STALE_THRESHOLD_MS
} from "./health";

// health.ts holds module-level mutable state, so reset it before each test
// to avoid one test's mutations leaking into the next.
beforeEach(() => {
  resetCycleStaleness();
  (Object.keys(endpointHealth) as (keyof typeof endpointHealth)[]).forEach((name) => {
    endpointHealth[name].lastSuccessAt = null;
    endpointHealth[name].lastAttemptAt = null;
    endpointHealth[name].lastError = null;
    endpointHealth[name].consecutiveFailures = 0;
  });
});

test("markEndpointSuccess clears failure state", () => {
  markEndpointFailure("brightline", new Error("boom"));
  expect(endpointHealth.brightline.consecutiveFailures).toBe(1);

  markEndpointSuccess("brightline");
  expect(endpointHealth.brightline.consecutiveFailures).toBe(0);
  expect(endpointHealth.brightline.lastError).toBeNull();
  expect(endpointHealth.brightline.lastSuccessAt).not.toBeNull();
});

test("markEndpointFailure increments consecutiveFailures and records the error", () => {
  markEndpointFailure("proxyFeed", new Error("network timeout"));
  markEndpointFailure("proxyFeed", new Error("network timeout"));
  expect(endpointHealth.proxyFeed.consecutiveFailures).toBe(2);
  expect(endpointHealth.proxyFeed.lastError).toBe("network timeout");
});

test("getEndpointHealthSnapshot flags an endpoint with no success yet as stale", () => {
  const snapshot = getEndpointHealthSnapshot();
  expect(snapshot.amtrakAlerts.stale).toBe(true);
  expect(snapshot.amtrakAlerts.staleMs).toBeNull();
});

test("getEndpointHealthSnapshot treats a recent success as not stale", () => {
  markEndpointSuccess("platforms");
  const snapshot = getEndpointHealthSnapshot();
  expect(snapshot.platforms.stale).toBe(false);
});

test("getEndpointHealthSnapshot flags an old success as stale", () => {
  markEndpointSuccess("viaProcessing");
  // backdate lastSuccessAt beyond the threshold, simulating time passing
  endpointHealth.viaProcessing.lastSuccessAt = Date.now() - (STALE_THRESHOLD_MS + 1000);
  const snapshot = getEndpointHealthSnapshot();
  expect(snapshot.viaProcessing.stale).toBe(true);
});

test("getShitsFucked is false when every endpoint is healthy", () => {
  (Object.keys(endpointHealth) as (keyof typeof endpointHealth)[]).forEach((name) => markEndpointSuccess(name));
  expect(getShitsFucked()).toBe(false);
});

test("getShitsFucked is true if even one endpoint is unhealthy (OR semantics)", () => {
  (Object.keys(endpointHealth) as (keyof typeof endpointHealth)[]).forEach((name) => markEndpointSuccess(name));
  // one single feed never having succeeded should flip the aggregate
  endpointHealth.stationRefresh.lastSuccessAt = null;
  expect(getShitsFucked()).toBe(true);
});

test("finalizeStaleness does not divide by zero when a provider has no active trains", () => {
  // amtrak/via/brightline all start with activeTrains = 0 after reset
  finalizeStaleness();
  const served = getServedProviderStaleData();
  expect(Number.isNaN(served.amtrak.avgLastUpdate)).toBe(false);
  expect(served.amtrak.avgLastUpdate).toBe(0);
  expect(served.amtrak.stale).toBe(false); // no active trains means "no data", not "stale"
});

test("finalizeStaleness isolates a stale provider instead of blending it into the combined median", () => {
  // Simulate: Amtrak has lots of fresh trains, VIA has one very stale train.
  for (let i = 0; i < 20; i++) {
    const timeSince = 5000; // 5s old, well within threshold
    staleData.avgLastUpdate += timeSince;
    staleData.lastUpdatedArr.push({ timeSince, trainID: `amtrak-${i}` });
    staleData.activeTrains++;

    providerStaleData.amtrak.avgLastUpdate += timeSince;
    providerStaleData.amtrak.lastUpdatedArr.push({ timeSince, trainID: `amtrak-${i}` });
    providerStaleData.amtrak.activeTrains++;
  }

  const staleTimeSince = STALE_THRESHOLD_MS + 1000 * 60 * 30; // very stale
  staleData.avgLastUpdate += staleTimeSince;
  staleData.lastUpdatedArr.push({ timeSince: staleTimeSince, trainID: "via-1" });
  staleData.activeTrains++;

  providerStaleData.via.avgLastUpdate += staleTimeSince;
  providerStaleData.via.lastUpdatedArr.push({ timeSince: staleTimeSince, trainID: "via-1" });
  providerStaleData.via.activeTrains++;

  finalizeStaleness();

  const combined = getServedStaleData();
  const perProvider = getServedProviderStaleData();

  // The combined median is dominated by the 20 fresh Amtrak entries, so the
  // blended view does NOT catch the stale VIA train — this is the exact
  // blind spot the per-provider breakdown exists to fix.
  expect(combined.stale).toBe(false);

  // But the per-provider view does catch it.
  expect(perProvider.via.stale).toBe(true);
  expect(perProvider.amtrak.stale).toBe(false);
});

test("resetCycleStaleness clears all counters back to zero", () => {
  providerStaleData.amtrak.activeTrains = 5;
  staleData.activeTrains = 5;
  resetCycleStaleness();
  expect(staleData.activeTrains).toBe(0);
  expect(providerStaleData.amtrak.activeTrains).toBe(0);
  expect(providerStaleData.via.activeTrains).toBe(0);
  expect(providerStaleData.brightline.activeTrains).toBe(0);
});
