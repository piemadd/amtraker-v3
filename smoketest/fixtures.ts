export const platformsFixture = {};

export const amtrakAlertsFixture = { trains: {} };

export const brightlineFixture = {
  v1: { trains: {}, stations: {} },
  platforms: {}
};

export const proxyFixtureHealthy = {
  trainDataVIA: {},
  trainStations: { features: [] },
  trainDataMain: { features: [] },
  trainDataASMAD: { features: [] },
  updatedTime: { updatedAt: Date.now(), updatedAtISO: new Date().toISOString(), updatedAtChicagoPlain: "" }
};
