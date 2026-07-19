// Smoke-test harness for the patched amtraker-v3 server.
//
// This intercepts the server's real fetch() calls to the 4 upstream feeds
// and substitutes fixture data, so we can boot the ACTUAL patched index.ts
// under a real Bun runtime without depending on network access to
// platformsapi.amtraker.com / store.transitstat.us (not reachable from most
// sandboxed environments, and not something to hit repeatedly from a test
// run anyway).
//
// Run modes (set via SMOKETEST_MODE env var before starting):
//   healthy        - all 4 feeds return valid fixture data
//   brightlineDown  - brightline feed always fails; everything else healthy

import { platformsFixture, amtrakAlertsFixture, brightlineFixture, proxyFixtureHealthy } from "./fixtures";
import {
  proxyFixtureMissingTrainStations,
  proxyFixtureViaEmptyTimes,
  proxyFixtureViaMissingCoords,
  brightlineFixtureEmptyPredictions,
  proxyFixtureAmtrakMixedGoodBad
} from "./fixtures-malformed";

const mode = process.env.SMOKETEST_MODE ?? "healthy";

const jsonResponse = (body: any) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.startsWith("https://platformsapi.amtraker.com/stations")) {
    return jsonResponse(platformsFixture);
  }

  if (url.startsWith("https://store.transitstat.us/amtrak_alerts")) {
    return jsonResponse(amtrakAlertsFixture);
  }

  if (url.startsWith("https://store.transitstat.us/brightline")) {
    if (mode === "brightlineDown") {
      throw new Error("simulated network failure: brightline upstream unreachable");
    }
    if (mode === "brightlineEmptyPredictions") {
      return jsonResponse(brightlineFixtureEmptyPredictions);
    }
    return jsonResponse(brightlineFixture);
  }

  if (url.startsWith("https://store.transitstat.us/amtrak_fetch_proxy")) {
    if (mode === "proxyMissingTrainStations") return jsonResponse(proxyFixtureMissingTrainStations);
    if (mode === "viaEmptyTimes") return jsonResponse(proxyFixtureViaEmptyTimes);
    if (mode === "viaMissingCoords") return jsonResponse(proxyFixtureViaMissingCoords);
    if (mode === "amtrakMixedGoodBad") return jsonResponse(proxyFixtureAmtrakMixedGoodBad);
    return jsonResponse(proxyFixtureHealthy);
  }

  throw new Error(`smoke test harness: unmocked fetch to ${url}`);
}) as typeof fetch;

console.log(`[smoketest] booting patched server in "${mode}" mode...`);

// Importing this runs index.ts's top-level code: safeUpdateTrains() fires
// immediately, setInterval is registered, and Bun.serve starts listening.
await import("../index");
