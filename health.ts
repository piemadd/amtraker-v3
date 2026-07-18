// Endpoint and provider health/staleness tracking, extracted from index.ts.
// This module owns all state for: (1) per-provider position-data staleness
// (staleData / providerStaleData) and (2) per-endpoint fetch/processing
// health (endpointHealth), replacing the original single `shitsFucked`
// boolean with granular, independently-tracked signals per feed and per
// provider. index.ts imports from here rather than declaring this state
// itself.

// ---- Position-data staleness (combined + per-provider) ----

export const staleData = {
  avgLastUpdate: 0,
  medianLastUpdate: 0,
  lastUpdatedArr: [] as object[],
  activeTrains: 0,
  stale: false
};

let servedStaleData = {
  avgLastUpdate: 0,
  medianLastUpdate: 0,
  lastUpdatedArr: [] as object[],
  activeTrains: 0,
  stale: false
};

// Position-data staleness broken out per provider, since the combined
// staleData above blends Amtrak/VIA/Brightline into one median — a stale
// VIA feed can hide behind a majority of fresh Amtrak trains in that number.
export type ProviderName = "amtrak" | "via" | "brightline";

const freshProviderStale = () => ({
  avgLastUpdate: 0,
  medianLastUpdate: 0,
  lastUpdatedArr: [] as object[],
  activeTrains: 0,
  stale: false
});

export const providerStaleData: Record<ProviderName, ReturnType<typeof freshProviderStale>> = {
  amtrak: freshProviderStale(),
  via: freshProviderStale(),
  brightline: freshProviderStale()
};

let servedProviderStaleData: Record<ProviderName, ReturnType<typeof freshProviderStale>> = {
  amtrak: freshProviderStale(),
  via: freshProviderStale(),
  brightline: freshProviderStale()
};

const getMedianOfArry = (arr: any[]) => {
  if (arr.length == 0) return 0; // no objects

  // sorting
  arr = arr.sort((a, b) => a.timeSince - b.timeSince);

  const half = Math.floor(arr.length / 2);

  return arr.length % 2 ? arr[half].timeSince : (arr[half - 1].timeSince + arr[half].timeSince) / 2;
};

// Called once at the start of each update cycle. staleData/providerStaleData
// are mutated in place by the provider processing loops in index.ts as they
// run, then finalized (below) once all three have finished.
export const resetCycleStaleness = () => {
  staleData.activeTrains = 0;
  staleData.avgLastUpdate = 0;
  staleData.medianLastUpdate = 0;
  staleData.lastUpdatedArr = [];
  staleData.stale = false;

  providerStaleData.amtrak = freshProviderStale();
  providerStaleData.via = freshProviderStale();
  providerStaleData.brightline = freshProviderStale();
};

// Called once at the end of each update cycle, after all three provider
// loops have accumulated into staleData/providerStaleData. Computes
// averages/medians, sets the `stale` flags, and commits the publicly-served
// snapshots (servedStaleData/servedProviderStaleData) that the API routes
// read from — kept separate from the live, in-progress counters above.
export const finalizeStaleness = () => {
  staleData.avgLastUpdate = staleData.activeTrains > 0 ? staleData.avgLastUpdate / staleData.activeTrains : 0;
  staleData.medianLastUpdate = getMedianOfArry(staleData.lastUpdatedArr);

  if (staleData.medianLastUpdate > STALE_THRESHOLD_MS) {
    console.log("Data is stale, setting...");
    staleData.stale = true;
  }

  servedStaleData = JSON.parse(JSON.stringify(staleData));

  // Same calculation as above, but per provider — so a stale VIA feed is
  // visible even when Amtrak/Brightline are both fresh and would otherwise
  // dominate the blended median in staleData.
  (Object.keys(providerStaleData) as ProviderName[]).forEach((provider) => {
    const p = providerStaleData[provider];
    p.avgLastUpdate = p.activeTrains > 0 ? p.avgLastUpdate / p.activeTrains : 0;
    p.medianLastUpdate = getMedianOfArry(p.lastUpdatedArr);
    p.stale = p.activeTrains > 0 && p.medianLastUpdate > STALE_THRESHOLD_MS;
    if (p.stale) console.log(`${provider} position data is stale, setting...`);
  });

  servedProviderStaleData = JSON.parse(JSON.stringify(providerStaleData));
};

export const getServedStaleData = () => servedStaleData;
export const getServedProviderStaleData = () => servedProviderStaleData;

// ---- Per-endpoint fetch/processing health ----

// Each upstream feed (plus the overall update cycle) is tracked separately so
// a Brightline outage doesn't read as "everything is broken" and vice versa.
// Fetch succeeding and processing succeeding are different failure modes —
// e.g. proxyFeed can fetch fine while a malformed VIA record still throws
// during parsing — so each stage has its own entry below.
export type EndpointName =
  | "platforms"
  | "amtrakAlerts"
  | "brightline"
  | "proxyFeed"
  | "updateCycle"
  | "brightlineProcessing"
  | "viaProcessing"
  | "amtrakProcessing"
  | "stationRefresh";

export interface EndpointHealthEntry {
  lastSuccessAt: number | null; // epoch ms of last successful fetch
  lastAttemptAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

const freshHealthEntry = (): EndpointHealthEntry => ({
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
  consecutiveFailures: 0
});

export const endpointHealth: Record<EndpointName, EndpointHealthEntry> = {
  platforms: freshHealthEntry(),
  amtrakAlerts: freshHealthEntry(),
  brightline: freshHealthEntry(),
  proxyFeed: freshHealthEntry(),
  updateCycle: freshHealthEntry(),
  brightlineProcessing: freshHealthEntry(),
  viaProcessing: freshHealthEntry(),
  amtrakProcessing: freshHealthEntry(),
  stationRefresh: freshHealthEntry()
};

// Matches the original codebase's own precedent for "stale" — the original
// median-train-update check used 20 minutes as its staleness cutoff, so
// per-feed staleness uses the same constant here instead of a new,
// separately-tuned number.
export const STALE_THRESHOLD_MS = 1000 * 60 * 20;

export const markEndpointSuccess = (name: EndpointName) => {
  const now = Date.now();
  endpointHealth[name].lastSuccessAt = now;
  endpointHealth[name].lastAttemptAt = now;
  endpointHealth[name].lastError = null;
  endpointHealth[name].consecutiveFailures = 0;
};

export const markEndpointFailure = (name: EndpointName, err: unknown) => {
  endpointHealth[name].lastAttemptAt = Date.now();
  endpointHealth[name].lastError = err instanceof Error ? err.message : String(err);
  endpointHealth[name].consecutiveFailures++;
};

// Computed at request time (not fetch time) so staleness reflects "how long
// ago" relative to now, not just whether the last attempt succeeded.
export const getEndpointHealthSnapshot = () => {
  const now = Date.now();
  const snapshot: Record<string, EndpointHealthEntry & { staleMs: number | null; stale: boolean }> = {} as any;
  (Object.keys(endpointHealth) as EndpointName[]).forEach((name) => {
    const entry = endpointHealth[name];
    const staleMs = entry.lastSuccessAt == null ? null : now - entry.lastSuccessAt;
    snapshot[name] = {
      ...entry,
      staleMs,
      stale: staleMs == null || staleMs > STALE_THRESHOLD_MS
    };
  });
  return snapshot;
};

// Kept for backward compatibility with existing consumers of the old
// single boolean — derived live as an OR across the individual per-endpoint
// stale flags above, rather than tracked as its own separate state.
export const getShitsFucked = () => Object.values(getEndpointHealthSnapshot()).some((entry) => entry.stale);
