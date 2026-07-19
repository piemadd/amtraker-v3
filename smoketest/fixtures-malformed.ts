// Malformed/partial-data fixtures, layered on top of the healthy baseline
// in fixtures.ts. Each named export represents one upstream payload variant
// used to stress a specific code path.

export const platformsFixture = {};
export const amtrakAlertsFixture = { trains: {} };

// --- Scenario: proxy feed missing the `trainStations` key entirely ---
// This is extracted OUTSIDE all three provider try/catch blocks (right after
// the proxy fetch, before Brightline/VIA/Amtrak processing begins), so if
// unguarded, this alone would abort the WHOLE cycle via the outer
// safeUpdateTrains catch — discarding Brightline/alerts data that already
// fetched fine in the same tick.
export const proxyFixtureMissingTrainStations = {
  trainDataVIA: {},
  // trainStations intentionally omitted
  trainDataMain: { features: [] },
  trainDataASMAD: { features: [] },
  updatedTime: { updatedAt: Date.now(), updatedAtISO: new Date().toISOString(), updatedAtChicagoPlain: "" }
};

// --- Scenario: VIA train with an empty times[] array ---
// firstStation/lastStation/trainEventStation would all resolve to undefined;
// the first property access on trainEventStation.code would throw before
// our viaCoords guard is ever reached.
export const proxyFixtureViaEmptyTimes = {
  trainDataVIA: {
    "84 1": {
      departed: true,
      times: [], // <- empty
      from: "Toronto",
      to: "Montreal",
      instance: "84-1-1",
      lat: 43.6,
      lng: -79.4,
      direction: 90,
      speed: 0,
      poll: new Date().toISOString(),
      alerts: []
    }
  },
  trainStations: { features: [] },
  trainDataMain: { features: [] },
  trainDataASMAD: { features: [] },
  updatedTime: { updatedAt: Date.now(), updatedAtISO: new Date().toISOString(), updatedAtChicagoPlain: "" }
};

// --- Scenario: VIA train whose event station code isn't in viaCoords ---
// Regression check for the guard we already added. Currently synthetic —
// checked the real data/stations.ts and viaStationNames/viaCoords keys
// match 1:1 today, so this simulates future data drift rather than a
// presently-real condition.
export const proxyFixtureViaMissingCoords = {
  trainDataVIA: {
    "84 1": {
      departed: true,
      times: [
        {
          code: "ZZZFAKE", // not present in stationMetaData.viaCoords
          arrival: { scheduled: new Date(Date.now() - 60000).toISOString() },
          departure: { scheduled: new Date().toISOString() },
          eta: "ENR"
        },
        {
          code: "MIMI", // real station code, present in real data
          arrival: { scheduled: new Date(Date.now() + 3600000).toISOString() },
          departure: { scheduled: new Date(Date.now() + 3660000).toISOString() },
          eta: "ENR"
        }
      ],
      from: "Toronto",
      to: "Montreal",
      instance: "84-1-2",
      lat: null,
      lng: null,
      direction: 90,
      speed: 60,
      poll: new Date().toISOString(),
      alerts: []
    }
  },
  trainStations: { features: [] },
  trainDataMain: { features: [] },
  trainDataASMAD: { features: [] },
  updatedTime: { updatedAt: Date.now(), updatedAtISO: new Date().toISOString(), updatedAtChicagoPlain: "" }
};

// --- Scenario: Brightline train with an empty predictions[] array ---
// Regression check for the guard we already added.
export const brightlineFixtureEmptyPredictions = {
  v1: {
    trains: {
      "1": { realTime: true, predictions: [], lat: 0, lon: 0, heading: 0 }
    },
    stations: {}
  },
  platforms: {}
};

// --- Scenario: Amtrak feature with a malformed station JSON field, mixed
// alongside a normal one --- tests whether one bad field poisons only that
// train (pre-existing per-field try/catch, not something we added, but
// worth confirming it actually holds under real execution).
export const proxyFixtureAmtrakMixedGoodBad = {
  trainDataVIA: {},
  trainStations: { features: [] },
  trainDataMain: {
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-76.6, 39.3] },
        properties: {
          TrainNum: "29",
          OrigSchDep: "07/18/2026 08:00:00",
          origcode: "ABE",
          destcode: "ABE",
          trainstate: "Active",
          velocity: "45",
          statusmsg: "",
          heading: "N",
          created_at: "07/18/2026 08:00:00",
          updated_at: "07/18/2026 08:05:00",
          lastvalts: "07/18/2026 08:05:00",
          OBJECTID: 111,
          routename: "Test Route",
          // station1 is deliberately invalid JSON — should be caught by the
          // existing per-field try/catch inside the Amtrak processing loop.
          station1: "{not valid json"
        }
      }
    ]
  },
  trainDataASMAD: { features: [] },
  updatedTime: { updatedAt: Date.now(), updatedAtISO: new Date().toISOString(), updatedAtChicagoPlain: "" }
};
