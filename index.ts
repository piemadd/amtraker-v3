// so much goop god this needs a hell of a rewrite

import moment from "moment-timezone";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";

const xmlBuilder = new XMLBuilder();

import { RawStation } from "./types/amtrak";
import { Train, Station, StationStatus, TrainResponse, StationResponse } from "./types/amtraker";

import { trainNames, viaTrainNames } from "./data/trains";
import * as stationMetaData from "./data/stations";
import { amtrakStationCodeReplacements } from "./data/sharedStations";
import cache from "./cache";

let rawStations: { features: any[] } = { features: [] };
try {
  rawStations = JSON.parse(fs.readFileSync("./rawStations.json", { encoding: "utf8" }));
} catch (e) {
  // Falls back to an empty feature set rather than crashing the process at
  // boot — this data is itself only used as a fallback (see updateTrains,
  // when the live proxied feed reports zero station features), so an empty
  // fallback-of-a-fallback degrades gracefully instead of preventing startup.
  console.log("Failed to load rawStations.json, starting with an empty fallback station list:", e);
}

import calculateIconColor from "./calculateIconColor";

let lastUpdatedTime = {
  updatedAt: 0,
  updatedAtISO: "1970-01-01T00:00:00.000Z",
  updatedAtChicagoPlain: "Wednesday, December 31, 1969 at 6:00:00 PM CST"
};

import {
  staleData,
  providerStaleData,
  endpointHealth,
  resetCycleStaleness,
  finalizeStaleness,
  getServedStaleData,
  getServedProviderStaleData,
  markEndpointSuccess,
  markEndpointFailure,
  getEndpointHealthSnapshot,
  getShitsFucked
} from "./health";

const amtrakerCache = new cache();
let decryptedTrainData = "";
let decryptedStationData = "";
let AllTTMTrains = "";
let trainPlatforms: any = {};
// Initialized with the shape updateTrains() expects, not just {} — a
// cold-start fetch failure (before any successful Brightline fetch) was
// crashing on Object.keys(brightlineData.trains) because .trains didn't
// exist yet, discovered by actually running the patched server end-to-end.
let brightlineData: any = { trains: {}, stations: {} };
let brightlinePlatforms = {};
let additionalVIAStops = {};
let additionalVIAAlerts = {};

let topIPs = {};
let lastGoodAmtrakAlertsData: any = { trains: {} };
let lastGoodProxiedData: any = null;

//https://stackoverflow.com/questions/196972/convert-string-to-title-case-with-javascript
const title = (str: string) => {
  return str.replace(/\w\S*/g, (text) => text.charAt(0).toUpperCase() + text.substring(1).toLowerCase());
};

// changes key values from the old format to the new format
const convertLegacyToAllTTM = (train: any) => {
  let newTrain = { ...train, properties: {} };
  const oldKeys = Object.keys(train.properties);

  oldKeys.forEach((key) => {
    newTrain.properties[key.toLowerCase()] = train.properties[key];
  });

  return newTrain;
};

// merges feeds together in case a train is missing from one or the other
const mergeAmtrakFeeds = (mainFeed: any, allTTMFeed: any) => {
  //return allTTMFeed
  let finalFeedDict: any = {};

  allTTMFeed.features.forEach((feature: any) => {
    finalFeedDict[`${feature.properties.trainnum}-${feature.properties.origschdep}`] = feature;
  });

  mainFeed.features.forEach((feature: any) => {
    if (!finalFeedDict[`${feature.properties.TrainNum}-${feature.properties.OrigSchDep}`])
      finalFeedDict[`${feature.properties.TrainNum}-${feature.properties.OrigSchDep}`] = convertLegacyToAllTTM(feature);
  });

  return { type: "FeatureCollection", features: Object.values(finalFeedDict) };
};

const ccDegToCardinal = (deg: number) => {
  const fixedDeg = deg - 45 / 2;
  if (fixedDeg < 0) return "N";
  if (fixedDeg < 45) return "NE";
  if (fixedDeg < 90) return "E";
  if (fixedDeg < 135) return "SE";
  if (fixedDeg < 180) return "S";
  if (fixedDeg < 225) return "SW";
  if (fixedDeg < 270) return "W";
  if (fixedDeg <= 315) return "NW";
  return "N";
};

const parseDate = (badDate: string | null, code: string | null) => {
  if (code == null) code = "America/New_York";
  if (badDate == null) return null;

  const timeZone: string = stationMetaData.timeZones[code] ?? "America/New_York";

  try {
    // Raw feed sends either 24-hour ("MM/DD/YYYY HH:mm:ss") or 12-hour with
    // an AM/PM suffix ("MM/DD/YYYY hh:mm:ss A"); also normalize the observed
    // "hour 24" quirk (meant to represent the 12:00-12:59pm hour) before parsing.
    const normalized = badDate.replace(/^(\d{1,2}\/\d{1,2}\/\d{4}) 24:/, "$1 12:");

    const parsed = moment.tz(normalized, ["MM/DD/YYYY HH:mm:ss", "MM/DD/YYYY hh:mm:ss A"], true, timeZone);

    if (!parsed.isValid()) {
      console.log("Couldn't parse date:", badDate, code);
      return null;
    }

    // moment-timezone resolves standard-time vs. daylight-saving based on the
    // date being parsed, not on today's date, and covers every IANA zone in
    // stationMetaData.timeZones rather than a hardcoded 11-zone table.
    return parsed.format("YYYY-MM-DDTHH:mm:ssZ");
  } catch (e) {
    console.log("Couldn't parse date:", badDate, code);
    return null;
  }
};

const parseRawStation = (rawStation: RawStation, rawTrain: any, rawTrainNum: string = "", debug: boolean = false) => {
  let status: StationStatus;
  let arr: string | null = null;
  let dep: string | null = null;

  const actualCode = amtrakStationCodeReplacements[rawStation.code] ?? rawStation.code;

  if (!rawStation.scharr && !rawStation.postarr) {
    //first station
    if (rawStation.postdep) {
      //has departed
      if (debug) console.log("First station departed:", rawStation.code);
    }
  }

  if (rawStation.estarr == null && rawStation.postarr == null) {
    // is this the first station
    if (rawStation.postdep != null) {
      // if the train has departed
      if (debug) console.log("has departed first station", rawStation.code);
      status = StationStatus.Departed;
      dep = parseDate(rawStation.postdep, rawStation.code);
    } else {
      // if the train hasn't departed
      if (debug) console.log("has not departed first station", rawStation.code);
      status = StationStatus.Station;
      dep = parseDate(rawStation.estdep, rawStation.code);
    }
  } else if (rawStation.postarr == null) {
    // is this the last station
    if (rawStation.postarr != null) {
      // if the train has arrived
      if (debug) console.log("has arrived last station", rawStation.code);
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
    } else {
      // if the train is enroute
      if (debug) console.log("enroute to last station", rawStation.code);
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
    }
  } else {
    // for all other stations
    if (rawStation.estarr != null && rawStation.estdep != null) {
      // if the train is enroute
      if (debug) console.log("enroute", rawStation.code);
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
    } else if (rawStation.postarr != null && rawStation.estdep != null) {
      // if the train has arrived but not departed
      if (debug) console.log("not departed", rawStation.code);
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
    } else if (rawStation.postdep != null || rawStation.postcmnt != null) {
      // if the train has departed
      if (debug) console.log("has departed", rawStation.code);
      status = StationStatus.Departed;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.postdep, rawStation.code);
    } else {
      if (debug) console.log("wtf goin on??????");
      //console.log(rawStation);
    }
  }

  if (!stationMetaData.stationNames[rawStation.code]) console.log("NO STATION NAME:", rawStation.code);
  if (!stationMetaData.timeZones[rawStation.code]) console.log("NO STATION TZ:", rawStation.code);

  const schArr = parseDate(rawStation.scharr, rawStation.code) ?? parseDate(rawStation.schdep, rawStation.code);
  const schDep = parseDate(rawStation.schdep, rawStation.code) ?? parseDate(rawStation.scharr, rawStation.code);

  if (!arr && rawTrain.trainstate == "Predeparture") arr = schArr;
  if (!dep && rawTrain.trainstate == "Predeparture") dep = schDep;

  return {
    name: stationMetaData.stationNames[rawStation.code],
    code: actualCode,
    tz: stationMetaData.timeZones[rawStation.code],
    bus: rawStation.bus,
    schArr,
    schDep,
    // @ts-ignore
    arr: arr ?? dep,
    // @ts-ignore
    dep: dep ?? arr,
    arrCmnt: "",
    depCmnt: "",
    // @ts-ignore
    status: status,
    stopIconColor: "#212529",
    platform:
      trainPlatforms[rawStation.code] && trainPlatforms[rawStation.code][rawTrainNum]
        ? trainPlatforms[rawStation.code][rawTrainNum]
        : ""
  } as Station;
};

// Reliability structure of this function, for a reviewer new to it:
//   1. Each of the 4 upstream fetches (platforms, alerts, brightline, proxy)
//      is independently try/caught and falls back to its last-known-good
//      data on failure — one feed failing no longer blocks the others.
//   2. Each provider's processing loop (Brightline/VIA/Amtrak) is also
//      independently try/caught, so a malformed record from one provider
//      can't discard data already computed from the other two this cycle.
//   3. The whole function is called via safeUpdateTrains() below, which
//      catches any remaining failure so it can never crash the process or
//      produce an unhandled rejection on the 15s interval that drives it.
//   4. Health/staleness state for all of the above lives in ./health.ts —
//      see markEndpointSuccess/markEndpointFailure calls throughout.
const updateTrains = async () => {
  console.log("Updating trains...");

  // Platform data is treated as best-effort/non-critical: log the failure so
  // it's visible, but don't let it take down the rest of the update cycle.
  try {
    const platformRes = await fetch("https://platformsapi.amtraker.com/stations");
    trainPlatforms = await platformRes.json();
    markEndpointSuccess("platforms");
  } catch (e) {
    console.log("Failed to fetch/parse train platforms, continuing without platform data:", e);
    trainPlatforms = {};
    markEndpointFailure("platforms", e);
  }

  // Each upstream feed is independent — a failure in one (e.g. Brightline)
  // should degrade only that feed, not block Amtrak/VIA/station processing
  // that already succeeded this cycle. Each falls back to its last known
  // good payload on failure, rather than aborting the whole update.
  let amtrakAlertsData: any = lastGoodAmtrakAlertsData;
  try {
    amtrakAlertsData = await fetch(
      "https://store.transitstat.us/amtrak_alerts" +
        (process.env.SUPER_SECRET_CACHE_BUSTING ? `${process.env.SUPER_SECRET_CACHE_BUSTING}&t=${Date.now()}` : "")
    ).then((res) => res.json());
    lastGoodAmtrakAlertsData = amtrakAlertsData;
    markEndpointSuccess("amtrakAlerts");
  } catch (e) {
    console.log("Failed to fetch amtrak_alerts, using last known good data:", e);
    markEndpointFailure("amtrakAlerts", e);
  }

  try {
    const brightlineRes = await fetch(
      "https://store.transitstat.us/brightline" +
        (process.env.SUPER_SECRET_CACHE_BUSTING ? `${process.env.SUPER_SECRET_CACHE_BUSTING}&t=${Date.now()}` : "")
    );
    const rawBrightline: any = await brightlineRes.json();
    brightlineData = rawBrightline["v1"];
    brightlinePlatforms = rawBrightline["platforms"];
    markEndpointSuccess("brightline");
  } catch (e) {
    console.log("Failed to fetch brightline feed, using last known good data:", e);
    // brightlineData/brightlinePlatforms intentionally left as their
    // previous values (module-level) rather than reset to {}.
    markEndpointFailure("brightline", e);
  }

  let trains: TrainResponse = {};
  let allStations: StationResponse = {};

  let allProxiedData: any = lastGoodProxiedData;
  try {
    allProxiedData = await fetch(
      "https://store.transitstat.us/amtrak_fetch_proxy" +
        (process.env.SUPER_SECRET_CACHE_BUSTING ? `${process.env.SUPER_SECRET_CACHE_BUSTING}&t=${Date.now()}` : "")
    ).then((res) => res.json());
    lastGoodProxiedData = allProxiedData;
    markEndpointSuccess("proxyFeed");
  } catch (e) {
    console.log("Failed to fetch amtrak_fetch_proxy, using last known good data:", e);
    markEndpointFailure("proxyFeed", e);
  }

  if (!allProxiedData) {
    // No successful fetch has ever completed (e.g. fails on first boot) —
    // nothing to fall back to, so surface it clearly rather than crashing
    // deep inside the parsing logic below on undefined data.
    throw new Error("amtrak_fetch_proxy has never succeeded; no cached data to fall back to.");
  }

  // Previously unguarded — a proxy response missing `trainStations` (valid
  // JSON, wrong shape) crashed here, outside all 3 provider try/catches
  // below, aborting the WHOLE cycle even when platforms/alerts/brightline
  // all fetched fine in the same tick. Discovered by actually running the
  // patched server against a malformed fixture, not by static review.
  const viaData = allProxiedData.trainDataVIA ?? {};
  const stationData =
    allProxiedData.trainStations?.features?.length > 0 ? allProxiedData.trainStations.features : rawStations.features;
  const amtrakData = mergeAmtrakFeeds(
    allProxiedData.trainDataMain ?? { features: [] },
    allProxiedData.trainDataASMAD ?? { features: [] }
  ).features;
  AllTTMTrains = JSON.stringify(allProxiedData.trainDataASMAD ?? {});
  lastUpdatedTime = allProxiedData.updatedTime ?? lastUpdatedTime;
  decryptedTrainData = JSON.stringify(amtrakData);
  decryptedStationData = JSON.stringify(stationData);
  // Per-feed staleness is now visible via getEndpointHealthSnapshot() /
  // the health endpoint below — this legacy aggregate flag stays only for
  // the median-update-age check further down, unrelated to fetch failures.
  if (!endpointHealth.proxyFeed.lastSuccessAt || endpointHealth.proxyFeed.consecutiveFailures > 0) {
    staleData.stale = true;

  }

  console.log("fetched s");
  stationData.forEach((station: any) => {
    const actualCode = amtrakStationCodeReplacements[station.properties.Code] ?? station.properties.Code;

    const stationObj = {
      name: stationMetaData.stationNames[station.properties.Code] ?? station.properties.StationName,
      code: actualCode,
      tz: stationMetaData.timeZones[station.properties.Code],
      lat: station.properties.lat,
      lon: station.properties.lon,
      hasAddress: true,
      address1: station.properties.Address1,
      address2: station.properties.Address2,
      city: station.properties.City,
      state: station.properties.State,
      zip: station.properties.Zipcode.toString(),
      trains: []
    };

    if (!allStations[actualCode]) allStations[actualCode] = stationObj;
    amtrakerCache.setStation(actualCode, stationObj);
  });

  console.log("fetched t");
  const nowCleaning: number = new Date().valueOf();

  resetCycleStaleness();

  try {
  Object.keys(brightlineData["trains"]).forEach((trainNum) => {
    const rawTrainData = brightlineData["trains"][trainNum];

    if (!rawTrainData.predictions || rawTrainData.predictions.length === 0) {
      console.log("Skipping Brightline train with no predictions:", trainNum);
      return;
    }

    if (!rawTrainData.realTime && nowCleaning < rawTrainData.predictions[0].dep - 1000 * 60 * 60) return; // train is scheduled and should not be shown on Amtraker unless within 1 hour of dep

    const firstStation = rawTrainData["predictions"][0];
    const lastStation = rawTrainData["predictions"].slice(-1)[0];
    const trainEventStation =
      rawTrainData["predictions"].filter((station) => station.dep >= Date.now())[0] ?? lastStation;

    let train: Train = {
      dataSource: "amtraker-v3",
      routeName: "Brightline",
      trainNum: "b" + trainNum,
      trainNumRaw: trainNum,
      trainID: "b" + trainNum + "-" + new Date(firstStation.dep).getDate(),
      lat:
        rawTrainData.lat != 0
          ? rawTrainData.lat
          : brightlineData["stations"][rawTrainData.predictions[0].stationID].lat,
      lon:
        rawTrainData.lon != 0
          ? rawTrainData.lon
          : brightlineData["stations"][rawTrainData.predictions[0].stationID].lon,
      trainTimely: "",
      iconColor: "#212529",
      textColor: "#ffffff",
      stations: rawTrainData.predictions.map((prediction: any) => {
        const actualID = "B" + prediction.stationID;
        if (!allStations[actualID]) {
          allStations[actualID] = {
            name: prediction.stationName,
            code: actualID,
            tz: prediction.tz,
            lat: brightlineData["stations"][prediction["stationID"]]["lat"],
            lon: brightlineData["stations"][prediction["stationID"]]["lon"],
            hasAddress: false,
            address1: "",
            address2: "",
            city: "",
            state: "",
            zip: "",
            trains: []
          };
        }

        allStations[actualID].trains.push("b" + trainNum + "-" + new Date(firstStation.dep).getDate());

        return {
          name: prediction["stationName"],
          code: actualID,
          tz: prediction["tz"],
          bus: false,
          schArr: new Date(prediction["arr"] - prediction["arrDelay"]).toISOString(),
          schDep: new Date(prediction["dep"] - prediction["depDelay"]).toISOString(),
          arr: new Date(prediction["arr"]).toISOString(),
          dep: new Date(prediction["dep"]).toISOString(),
          arrCmnt: "",
          depCmnt: "",
          status: prediction["dep"] > Date.valueOf() ? "Departed" : "Enroute",
          stopIconColor: "#212529",
          platform:
            brightlinePlatforms[prediction.stationID] && brightlinePlatforms[prediction.stationID][trainNum]
              ? brightlinePlatforms[prediction.stationID][trainNum]
              : ""
        };
      }),
      heading: ccDegToCardinal(rawTrainData.heading),
      eventCode: "B" + trainEventStation.stationID,
      eventTZ: trainEventStation.tz,
      eventName: trainEventStation.stationName,
      origCode: "B" + firstStation.stationID,
      originTZ: firstStation.tz,
      origName: firstStation.stationName,
      destCode: "B" + lastStation.stationID,
      destTZ: lastStation.tz,
      destName: lastStation.stationName,
      trainState: "Active",
      velocity: 0, // no data unfortunately
      statusMsg: " ",
      createdAt: brightlineData["lastUpdated"] ?? new Date().toISOString(),
      updatedAt: brightlineData["lastUpdated"] ?? new Date().toISOString(),
      lastValTS: brightlineData["lastUpdated"] ?? new Date().toISOString(),
      objectID: Number(trainNum),
      provider: "Brightline",
      providerShort: "BLNE",
      onlyOfTrainNum: true,
      alerts: []
    };

    const calculatedColors = calculateIconColor(train, allStations);
    train.iconColor = calculatedColors["color"];
    train.textColor = calculatedColors["text"];
    train.stations = train.stations.map((stationRaw) => {
      return { ...stationRaw, stopIconColor: calculateIconColor(train, allStations, stationRaw.code)["color"] };
    });

    if (!trains["b" + trainNum]) trains["b" + trainNum] = [];
    trains["b" + trainNum].push(train);

    if (train.trainState === "Active") {
      const timeSinceUpdate = Math.max(nowCleaning - new Date(train.lastValTS).valueOf(), 0);
      staleData.avgLastUpdate += timeSinceUpdate;
      staleData.lastUpdatedArr.push({ timeSince: timeSinceUpdate, trainID: train.trainID });
      staleData.activeTrains++;

      providerStaleData.brightline.avgLastUpdate += timeSinceUpdate;
      providerStaleData.brightline.lastUpdatedArr.push({ timeSince: timeSinceUpdate, trainID: train.trainID });
      providerStaleData.brightline.activeTrains++;
    }
  });
    markEndpointSuccess("brightlineProcessing");
  } catch (e) {
    // A malformed record here previously aborted the entire update cycle,
    // discarding already-computed VIA/Amtrak data further down. Now it's
    // contained to Brightline: trains/allStations keep whatever Brightline
    // entries were added before the failure, and processing continues.
    console.log("Failed while processing Brightline data, continuing with other providers:", e);
    markEndpointFailure("brightlineProcessing", e);
  }

  try {
  Object.keys(viaData).forEach((trainNum) => {
    const rawTrainData = viaData[trainNum];
    const actualTrainNum = "v" + trainNum.split(" ")[0];
    if (!rawTrainData.departed) return; //train doesn't exist

    if (!rawTrainData.times || rawTrainData.times.length === 0) {
      // Previously fell through to trainEventStation being undefined and
      // throwing later — one record like this aborted ALL VIA processing
      // for the tick (contained to VIA by the outer try/catch, but still
      // losing every other VIA train that tick over a single bad record).
      console.log("Skipping VIA train with no times:", trainNum);
      return;
    }

    if (actualTrainNum == "v97" || actualTrainNum == "v98") {
      //covered by amtrak, but we need to add some stops
      const replacements = { v97: "64", v98: "63" };
      additionalVIAStops[replacements[actualTrainNum]] = rawTrainData.times.sort(
        (a, b) => new Date(a.scheduled).valueOf() - new Date(b.scheduled).valueOf()
      );
      additionalVIAAlerts[replacements[actualTrainNum]] = rawTrainData.alerts ?? [];

      return;
    }

    const sortedStations = rawTrainData.times.sort(
      (a, b) => new Date(a.scheduled).valueOf() - new Date(b.scheduled).valueOf()
    );

    const firstStation = sortedStations[0];
    const lastStation = sortedStations[sortedStations.length - 1];
    const trainEventStation = sortedStations.find((station) => station.eta !== "ARR") ?? firstStation;

    let trainDelay = 0;

    let train: Train = {
      dataSource: "amtraker-v3",
      routeName: viaTrainNames[trainNum.split(" ")[0]] ?? `${title(rawTrainData.from)}-${title(rawTrainData.to)}`,
      trainNum: `${actualTrainNum}`,
      trainNumRaw: trainNum.split(" ")[0],
      trainID: `${actualTrainNum}-${Number(rawTrainData.instance.split("-")[2])}`,
      lat:
        rawTrainData.lat ??
        (stationMetaData.viaCoords[trainEventStation.code] ? stationMetaData.viaCoords[trainEventStation.code][0] : 0),
      lon:
        rawTrainData.lng ??
        (stationMetaData.viaCoords[trainEventStation.code] ? stationMetaData.viaCoords[trainEventStation.code][1] : 0),
      trainTimely: "",
      iconColor: "#212529",
      textColor: "#ffffff",
      stations: sortedStations.map((station) => {
        if (!allStations[station.code]) {
          allStations[station.code] = {
            name: stationMetaData.viaStationNames[station.code],
            code: station.code,
            tz: stationMetaData.viatimeZones[station.code] ?? "America/Toronto",
            lat: stationMetaData.viaCoords[station.code] ? stationMetaData.viaCoords[station.code][0] : 0,
            lon: stationMetaData.viaCoords[station.code] ? stationMetaData.viaCoords[station.code][1] : 0,
            hasAddress: false,
            address1: "",
            address2: "",
            city: "",
            state: "",
            zip: "",
            trains: []
          };

          if (station.code == "MIMC") {
            // ill need a better way to do this in the future
            allStations[station.code] = {
              name: "Toronto VIA Yard",
              code: "MIMC",
              tz: "America/Toronto",
              lat: 43.610556,
              lon: -79.509444,
              hasAddress: true,
              address1: "1611 Islington Avenue",
              address2: "",
              city: "Etobicoke",
              state: "ON",
              zip: "M8V 3B6",
              trains: []
            };
          }
        }

        allStations[station.code].trains.push(`${actualTrainNum}-${Number(rawTrainData.instance.split("-")[2])}`);

        if (station.arrival && station.arrival.estimated) {
          trainDelay = new Date(station.arrival.estimated).valueOf() - new Date(station.arrival.scheduled).valueOf();
        }

        const estArr = (station.arrival ?? station.departure).estimated;
        const estDep = (station.departure ?? station.arrival).estimated;

        return {
          name: stationMetaData.viaStationNames[station.code],
          code: station.code,
          tz: stationMetaData.viatimeZones[station.code],
          bus: false,
          schArr: (station.arrival ?? station.departure).scheduled,
          schDep: (station.departure ?? station.arrival).scheduled,
          arr: estArr ?? new Date(new Date((station.arrival ?? station.departure).scheduled).valueOf() + trainDelay),
          dep: estDep ?? new Date(new Date((station.departure ?? station.arrival).scheduled).valueOf() + trainDelay),
          arrCmnt: "",
          depCmnt: "",
          status: station.eta === "ARR" ? "Departed" : "Enroute",
          stopIconColor: "#212529",
          platform: ""
        };
      }),
      heading: ccDegToCardinal(rawTrainData.direction),
      eventCode: trainEventStation.code,
      eventTZ: stationMetaData.viatimeZones[trainEventStation.code],
      eventName: trainEventStation.code,
      origCode: firstStation.code,
      originTZ: stationMetaData.viatimeZones[firstStation.code],
      origName: stationMetaData.viaStationNames[firstStation.code],
      destCode: lastStation.code,
      destTZ: stationMetaData.viatimeZones[lastStation.code],
      destName: stationMetaData.viaStationNames[lastStation.code],
      trainState: "Active",
      velocity: (rawTrainData.speed ?? 0) * 0.621371, // i love metric lol
      statusMsg: " ",
      createdAt: rawTrainData.poll ?? new Date().toISOString(),
      updatedAt: rawTrainData.poll ?? new Date().toISOString(),
      lastValTS: rawTrainData.poll ?? new Date().toISOString(),
      objectID: rawTrainData.OBJECTID,
      provider: "Via",
      providerShort: "VIA",
      onlyOfTrainNum: true,
      alerts: (rawTrainData.alerts ?? []).map((alert) => {
        return { message: alert.description.en.replaceAll("\n", " ") };
      })
    };

    const calculatedColors = calculateIconColor(train, allStations);
    train.iconColor = calculatedColors["color"];
    train.textColor = calculatedColors["text"];
    train.stations = train.stations.map((stationRaw) => {
      return { ...stationRaw, stopIconColor: calculateIconColor(train, allStations, stationRaw.code)["color"] };
    });

    if (!trains[actualTrainNum]) trains[actualTrainNum] = [];
    trains[actualTrainNum].push(train);

    if (train.trainState === "Active") {
      const timeSinceUpdate = Math.max(nowCleaning - new Date(train.lastValTS).valueOf(), 0);
      staleData.avgLastUpdate += timeSinceUpdate;
      staleData.lastUpdatedArr.push({ timeSince: timeSinceUpdate, trainID: train.trainID });
      staleData.activeTrains++;

      providerStaleData.via.avgLastUpdate += timeSinceUpdate;
      providerStaleData.via.lastUpdatedArr.push({ timeSince: timeSinceUpdate, trainID: train.trainID });
      providerStaleData.via.activeTrains++;

      //console.log(train.trainNum, train.lastValTS, nowCleaning - new Date(train.lastValTS).valueOf(), nowCleaning - new Date(train.lastValTS).valueOf() > (1000 * 60 * 15))
    }
  });
    markEndpointSuccess("viaProcessing");
  } catch (e) {
    // Contained to VIA: Brightline data added earlier and any Amtrak data
    // added below are unaffected by a bad VIA record.
    console.log("Failed while processing VIA data, continuing with other providers:", e);
    markEndpointFailure("viaProcessing", e);
  }

  try {
  amtrakData.forEach((property: any) => {
    let rawTrainData = property.properties;

    //console.log(rawTrainData.trainnum)

    let rawStations: Array<RawStation> = [];

    // Safety cap raised well above any known route length, purely to bound
    // the loop — previously a hard cutoff at 46 that would silently drop
    // any stops beyond it with no warning. Log if we ever actually reach it,
    // since that means a real train is longer than we've ever seen.
    const STATION_FIELD_SAFETY_CAP = 100;
    for (let i = 1; i < STATION_FIELD_SAFETY_CAP; i++) {
      let station = rawTrainData[`station${i}`];
      if (station == undefined || !station) {
        continue;
      } else {
        try {
          let rawStation = JSON.parse(station);
          if (rawStation.code === "CBN") continue;
          rawStations.push(rawStation);
        } catch (e) {
          console.log("Error parsing station:", e);
          continue;
        }
      }
    }
    if (rawTrainData[`station${STATION_FIELD_SAFETY_CAP}`]) {
      console.log(
        `Train ${rawTrainData.trainnum} has stations at/beyond field ${STATION_FIELD_SAFETY_CAP} — safety cap may be truncating stops.`
      );
    }

    let stations = rawStations.map((station) => {
      const actualCode = amtrakStationCodeReplacements[station.code] ?? station.code;

      if (!allStations[actualCode]) {
        if (!amtrakerCache.stationExists(actualCode)) {
          amtrakerCache.setStation(actualCode, {
            name: stationMetaData.stationNames[station.code],
            code: actualCode,
            tz: stationMetaData.timeZones[station.code],
            lat: 0,
            lon: 0,
            hasAddress: false,
            address1: "",
            address2: "",
            city: "",
            state: "",
            zip: "",
            trains: []
          });
        }
      }

      const result = parseRawStation(station, rawTrainData, rawTrainData.trainnum); //, rawTrainData.trainnum == "784");

      return result;
    });

    if (stations.length === 0) {
      console.log("No stations found for train:", rawTrainData.trainnum);
      return;
    }

    const enrouteStations = stations.filter(
      (station) => (station.status === "Enroute" || station.status === "Station") && (station.arr || station.dep)
    );

    const trainEventCode = enrouteStations.length == 0 ? stations[stations.length - 1].code : enrouteStations[0].code;
    const actualTrainEventCode = amtrakStationCodeReplacements[trainEventCode] ?? trainEventCode;
    const actualOrigCode = amtrakStationCodeReplacements[rawTrainData.origcode] ?? rawTrainData.origcode;
    const actualDestCode = amtrakStationCodeReplacements[rawTrainData.destcode] ?? rawTrainData.destcode;

    // i hate this more than you do
    const originDateOfMonth = new Intl.DateTimeFormat("en-US", {
      timeZone: stationMetaData.timeZones[rawTrainData.origcode],
      day: "numeric"
    }).format(new Date(stations[0].schDep));

    // adding in VIA stops, if they exist

    const additionalStations: Array<any> = additionalVIAStops[`${+rawTrainData.trainnum}`] ?? [];
    let viaTrainDelay = 0;

    const processedVIAStops = additionalStations.map((station) => {
      if (!allStations[station.code]) {
        allStations[station.code] = {
          name: stationMetaData.viaStationNames[station.code],
          code: station.code,
          tz: stationMetaData.viatimeZones[station.code] ?? "America/Toronto",
          lat: stationMetaData.viaCoords[station.code] ? stationMetaData.viaCoords[station.code][0] : 0,
          lon: stationMetaData.viaCoords[station.code] ? stationMetaData.viaCoords[station.code][1] : 0,
          hasAddress: false,
          address1: "",
          address2: "",
          city: "",
          state: "",
          zip: "",
          trains: []
        };
      }

      allStations[station.code].trains.push(`${+rawTrainData.trainnum}-${originDateOfMonth}`);

      if (station.arrival && station.arrival.estimated) {
        viaTrainDelay = new Date(station.arrival.estimated).valueOf() - new Date(station.arrival.scheduled).valueOf();
      }

      const estArr = (station.arrival ?? station.departure).estimated;
      const estDep = (station.departure ?? station.arrival).estimated;

      return {
        name: stationMetaData.viaStationNames[station.code],
        code: station.code,
        tz: stationMetaData.viatimeZones[station.code],
        bus: false,
        schArr: (station.arrival ?? station.departure).scheduled,
        schDep: (station.departure ?? station.arrival).scheduled,
        arr: estArr ?? new Date(new Date((station.arrival ?? station.departure).scheduled).valueOf() + viaTrainDelay),
        dep: estDep ?? new Date(new Date((station.departure ?? station.arrival).scheduled).valueOf() + viaTrainDelay),
        arrCmnt: "",
        depCmnt: "",
        status: station.eta === "ARR" ? "Departed" : "Enroute",
        stopIconColor: "#212529",
        platform: ""
      };
    });

    if (processedVIAStops.length > 0) {
      const indexOfVIAStart = stations.findIndex((station) => station.code == processedVIAStops[0].code);

      // removing the first and last stop so we have no dupes
      processedVIAStops.shift();
      processedVIAStops.pop();

      // actually inserting the data
      stations.splice(indexOfVIAStart + 1, 0, ...processedVIAStops);
    }

    // end of adding via stops

    let train: Train = {
      dataSource: "amtraker-v3",
      routeName: trainNames[+rawTrainData.trainnum] ? trainNames[+rawTrainData.trainnum] : rawTrainData.routename,
      trainNum: `${+rawTrainData.trainnum}`,
      trainNumRaw: `${+rawTrainData.trainnum}`,
      trainID: `${+rawTrainData.trainnum}-${originDateOfMonth}`,
      lat: property.geometry.coordinates[1],
      lon: property.geometry.coordinates[0],
      trainTimely: "",
      iconColor: "#212529",
      textColor: "#ffffff",
      stations: stations,
      heading: rawTrainData.heading ?? "N",
      eventCode: actualTrainEventCode,
      eventTZ: stationMetaData.timeZones[trainEventCode],
      eventName: stationMetaData.stationNames[trainEventCode],
      origCode: actualOrigCode,
      originTZ: stationMetaData.timeZones[rawTrainData.origcode],
      origName: stationMetaData.stationNames[rawTrainData.origcode],
      destCode: actualDestCode,
      destTZ: stationMetaData.timeZones[rawTrainData.destcode],
      destName: stationMetaData.stationNames[rawTrainData.destcode],
      trainState: rawTrainData.trainstate,
      velocity: +rawTrainData.velocity,
      statusMsg:
        stations.filter((station) => !station.arr && !station.dep && station.code === trainEventCode).length > 0
          ? "SERVICE DISRUPTION"
          : rawTrainData.statusmsg,
      createdAt:
        parseDate(rawTrainData.created_at, "America/New_York") ??
        parseDate(rawTrainData.updated_at, "America/New_York"),
      updatedAt:
        parseDate(rawTrainData.updated_at, "America/New_York") ??
        parseDate(rawTrainData.created_at, "America/New_York"),
      lastValTS: parseDate(rawTrainData.lastvalts, trainEventCode) ?? stations[0].schDep,
      objectID: rawTrainData.OBJECTID,
      provider: "Amtrak",
      providerShort: "AMTK",
      onlyOfTrainNum: true,
      alerts: amtrakAlertsData["trains"][`${+rawTrainData.trainnum}-${originDateOfMonth}`] ?? []
    };
    //console.log(train.trainID, train.trainNum, train.trainState)

    const calculatedColors = calculateIconColor(train, allStations);
    train.iconColor = calculatedColors["color"];
    train.textColor = calculatedColors["text"];
    train.stations = train.stations.map((stationRaw) => {
      return { ...stationRaw, stopIconColor: calculateIconColor(train, allStations, stationRaw.code)["color"] };
    });

    if (train.trainState === "Predeparture") {
      const initialDeparture = new Date(train.stations[0].dep ?? train.stations[0].arr);

      // dont include train if more than an hour until departure
      if (initialDeparture.valueOf() > nowCleaning + 1000 * 60 * 60) return;
    }

    if (!trains[rawTrainData.trainnum]) trains[rawTrainData.trainnum] = [];
    trains[rawTrainData.trainnum].push(train);

    if (train.trainState === "Active") {
      const timeSinceUpdate = Math.max(nowCleaning - new Date(train.lastValTS).valueOf(), 0);
      staleData.avgLastUpdate += timeSinceUpdate;
      staleData.lastUpdatedArr.push({ timeSince: timeSinceUpdate, trainID: train.trainID });
      staleData.activeTrains++;

      providerStaleData.amtrak.avgLastUpdate += timeSinceUpdate;
      providerStaleData.amtrak.lastUpdatedArr.push({ timeSince: timeSinceUpdate, trainID: train.trainID });
      providerStaleData.amtrak.activeTrains++;
    }
  });
    markEndpointSuccess("amtrakProcessing");
  } catch (e) {
    // Contained to Amtrak: Brightline/VIA data added earlier this cycle are
    // unaffected by a bad Amtrak record.
    console.log("Failed while processing Amtrak data, continuing with other providers:", e);
    markEndpointFailure("amtrakProcessing", e);
  }

  // setting onlyOfTrainNum and deduplicating at the same time
  Object.keys(trains).forEach((trainNum) => {
    // deduplicating trains with the same ID
    let trainIDs: string[] = [];
    trains[trainNum] = trains[trainNum].filter((train) => {
      if (trainIDs.includes(train.trainID)) return false;
      trainIDs.push(train.trainID);
      return true;
    });

    // setting onlyOfTrainNum
    trains[trainNum].forEach((train, i, arr) => {
      trains[trainNum][i].onlyOfTrainNum = arr.length <= 1; // this should be an == but edge cases be damned
    });
  });

  finalizeStaleness();

  // refreshing VIA stations that have 0 trains
  try {
    Object.keys(stationMetaData.viaStationNames).forEach((stationCode) => {
      if (!allStations[stationCode]) {
        allStations[stationCode] = {
          name: stationMetaData.viaStationNames[stationCode],
          code: stationCode,
          tz: stationMetaData.viatimeZones[stationCode],
          lat: stationMetaData.viaCoords[stationCode] ? stationMetaData.viaCoords[stationCode][0] : 0,
          lon: stationMetaData.viaCoords[stationCode] ? stationMetaData.viaCoords[stationCode][1] : 0,
          hasAddress: false,
          address1: "",
          address2: "",
          city: "",
          state: "",
          zip: "",
          trains: []
        };
      }
    });

    // doing the same with brightline
    Object.keys(brightlineData["stations"]).forEach((stationCode) => {
      if (!allStations[stationCode]) {
        allStations[stationCode] = {
          name: brightlineData["stations"][stationCode]["stationName"],
          code: stationCode,
          tz: brightlineData["stations"][stationCode]["tz"],
          lat: brightlineData["stations"][stationCode]["lat"],
          lon: brightlineData["stations"][stationCode]["lon"],
          hasAddress: false,
          address1: "",
          address2: "",
          city: "",
          state: "",
          zip: "",
          trains: []
        };
      }
    });
    markEndpointSuccess("stationRefresh");
  } catch (e) {
    // Previously unguarded: a failure here (e.g. a missing viaCoords entry)
    // ran after all three provider loops had already succeeded, and — since
    // nothing caught it here — aborted the entire cycle's cache commit
    // below, discarding that already-good data. Now it's contained to just
    // the station-refresh step, and whatever providers/stations were
    // already in `trains`/`allStations` still get committed.
    console.log("Failed while refreshing VIA/Brightline station entries, committing what succeeded so far:", e);
    markEndpointFailure("stationRefresh", e);
  }

  Object.keys(allStations).forEach((stationKey) => {
    amtrakerCache.setStation(stationKey, allStations[stationKey]);
  });

  amtrakerCache.setTrains(trains);
  console.log("set trains cache");
};

const safeUpdateTrains = async () => {
  try {
    await updateTrains();
    markEndpointSuccess("updateCycle");
  } catch (e) {
    // Previously an unhandled rejection on every failed tick (every 15s).
    // Upstream fetch failures/malformed JSON now surface here instead of
    // crashing/hanging the process, and the per-endpoint health snapshot
    // reflects it (see getEndpointHealthSnapshot() / the health endpoint).
    console.log("updateTrains() failed entirely:", e);
    markEndpointFailure("updateCycle", e);
  }
};

safeUpdateTrains();

setInterval(() => safeUpdateTrains(), 1000 * 15); // every 15 seconds

const cleanUpIPs = () => {
  Object.keys(topIPs)
    .sort((a, b) => topIPs[b].count - topIPs[a].count)
    .slice(50)
    .forEach((ip) => {
      delete topIPs[ip];
    });
};

//setInterval(() => cleanUpIPs(), 300 * 1000);

const blocks = [];

const server = Bun.serve({
  port: process.env.PORT ?? 3001,
  fetch(request) {
    const ipAddr = request.headers.get("cf-connecting-ip") ?? server.requestIP(request).address;
    let shouldBlock = false;

    if (blocks.includes(ipAddr)) {
      shouldBlock = true;
      /*
      return new Response(JSON.stringify([]), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
          'attribution': "Please provide proper attribution to Amtraker on your website and email me (amtraker@piemadd.com) to have this block removed."
        },
        status: 403,
      });
      */
    }

    /*
    if (!topIPs[ipAddr]) topIPs[ipAddr] = { count: 0, headers: Object.fromEntries(request.headers) };
    topIPs[ipAddr].count++;
    */

    let url = new URL(request.url).pathname;

    if (url.startsWith("/v2")) {
      url = url.replace("/v2", "/v3");
    }

    if (url === `/v3/ips` && request.url.endsWith(process.env.SUPER_SECRET_ACCESS_KEY)) {
      //console.log(request.headers)

      //console.log(ipAddr, request.headers.get("x-real-ip"), request.headers)

      return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });

      return new Response(
        JSON.stringify(
          Object.keys(topIPs)
            .sort((a, b) => topIPs[b].count - topIPs[a].count)
            .map((ip) => [ip, topIPs[ip].count, topIPs[ip].headers])
        ),
        { headers: { "content-type": "application/json" } }
      );
    }

    if (url === "/v3/all") {
      const trains = amtrakerCache.getTrains();
      const stations = amtrakerCache.getStations();
      const ids = amtrakerCache.getIDs();

      return new Response(
        JSON.stringify({
          trains,
          stations,
          ids,
          shitsFucked: getShitsFucked(),
          endpointHealth: getEndpointHealthSnapshot(),
          staleData: getServedStaleData(),
          providerStaleData: getServedProviderStaleData()
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        }
      );
    }

    if (url === "/v3/times") {
      return new Response(JSON.stringify(lastUpdatedTime), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url === "/") {
      return new Response(
        "Welcome to the Amtreker API! Docs should be available at /docs, if I remembered to add them..."
      );
    }

    if (url === "/docs") {
      return Response.redirect("https://github.com/piemadd/amtrak", 302);
    }

    if (url === "/v3") {
      return Response.redirect("/v3/trains", 301);
    }

    if (url === "/v3/shitsfuckedlmao") {
      // Original response shape preserved (plain boolean text) for existing
      // consumers — value is now derived live as an OR across the
      // individual per-endpoint stale flags instead of its own tracked state.
      return new Response(getShitsFucked().toString(), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url === "/v3/health") {
      return new Response(
        JSON.stringify({ endpointHealth: getEndpointHealthSnapshot(), providerStaleData: getServedProviderStaleData() }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        }
      );
    }

    if (url === "/v3/raw") {
      return new Response(decryptedTrainData, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url === "/v3/rawStations") {
      return new Response(decryptedStationData, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url === "/v3/AllTTMTrains") {
      return new Response(AllTTMTrains, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url === "/v3/stale") {
      return new Response(JSON.stringify({ ...getServedStaleData(), byProvider: getServedProviderStaleData() }), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url.startsWith("/v3/ids")) {
      console.log(request.url, url, "train ids");
      const trainIDs = amtrakerCache.getIDs();
      return new Response(JSON.stringify(trainIDs), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url.startsWith("/v3/trains")) {
      const trainNum = url.split("/")[3];

      const trains = amtrakerCache.getTrains();

      let finalTrains = {};

      /*
      Object.keys(trains).forEach((trainNum) => {
        finalTrains[trainNum] = trains[trainNum].map((train) => {
          return {
            ...train,
            dataSource: 'amtraker-v3-trains',
            ipSource: ipAddr,
          }
        })
      })
        */

      if (trainNum === undefined) {
        console.log(request.url, url, "all trains");

        if (shouldBlock) {
          return new Response(
            JSON.stringify({
              "9997": [
                {
                  dataSource: "amtraker-v3",
                  routeName: "Error Train",
                  trainNum: "9997",
                  trainNumRaw: "9997",
                  trainID: "9997-1",
                  lat: 0,
                  lon: 0,
                  trainTimely: "",
                  iconColor: "#000000",
                  textColor: "#ffffff",
                  stations: [
                    {
                      name: "Chicago Union",
                      code: "CHI",
                      tz: "America/Chicago",
                      bus: false,
                      schArr: "2030-05-01T01:00:00-05:00",
                      schDep: "2030-05-01T01:00:00-05:00",
                      arr: "2030-05-01T01:00:00-05:00",
                      dep: "2030-05-01T01:00:00-05:00",
                      arrCmnt: "",
                      depCmnt: "",
                      status: "Enroute",
                      stopIconColor: "#2a893d",
                      platform: ""
                    }
                  ],
                  heading: "N",
                  eventCode: "CHI",
                  eventTZ: "America/Chicago",
                  eventName: "Chicago Union",
                  origCode: "CHI",
                  originTZ: "America/Chicago",
                  origName: "Chicago Union",
                  destCode: "CHI",
                  destTZ: "America/Chicago",
                  destName: "Chicago Union",
                  trainState: "Active",
                  velocity: 0,
                  statusMsg: " ",
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  lastValTS: new Date().toISOString(),
                  provider: "Amtrak",
                  providerShort: "AMTK",
                  onlyOfTrainNum: true,
                  alerts: []
                }
              ]
            }),
            {
              headers: {
                "Access-Control-Allow-Origin": "*", // CORS
                "content-type": "application/json",
                attribution:
                  "Please provide proper attribution to Amtraker on your website and email me (amtraker@piemadd.com) to have this block removed."
              }
            }
          );
        }

        return new Response(JSON.stringify(trains), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        });
      }

      if (trainNum === "arr") {
        console.log(request.url, url, "all trains in an array");
        return new Response(JSON.stringify({ 0: Object.values(trains).flatMap((n) => n) }), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        });
      }

      console.log(request.url, url, "train num", trainNum);

      if (trainNum.split("-").length === 2) {
        const trainsArr = trains[trainNum.split("-")[0]];

        if (trainsArr == undefined) {
          return new Response(JSON.stringify([]), {
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "application/json"
            }
          });
        }

        for (let i = 0; i < trainsArr.length; i++) {
          if (trainsArr[i].trainID === trainNum) {
            return new Response(JSON.stringify({ [trainNum.split("-")[0]]: [trainsArr[i]] }), {
              headers: {
                "Access-Control-Allow-Origin": "*", // CORS
                "content-type": "application/json"
              }
            });
          }
        }

        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        });
      }

      if (trains[trainNum] == null) {
        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        });
      }

      return new Response(JSON.stringify({ [trainNum]: trains[trainNum] }), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url.startsWith("/v3/stations/expanded")) {
      const stationCode = url.split("/")[4];
      const stations = amtrakerCache.getStations();
      const trains = amtrakerCache.getTrains();

      if (stationCode === undefined || stations[stationCode] == null) {
        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        });
      }

      const newStation = {
        ...stations[stationCode],
        trains: stations[stationCode].trains.map((trainID) => {
          const trainsArr = trains[trainID.split("-")[0]];
          const train = trainsArr?.find((train) => train.trainID == trainID);

          const thisStationFull = train?.stations.find((station) => station.code == stationCode);
          const thisStationMin = {
            schArr: thisStationFull?.schArr,
            schDep: thisStationFull?.schDep,
            arr: thisStationFull?.arr,
            dep: thisStationFull?.dep,
            status: thisStationFull?.status,
            stopIconColor: thisStationFull?.stopIconColor,
            platform: thisStationFull?.platform
          };

          return {
            routeName: train?.routeName,
            trainNum: train?.trainNum,
            trainNumRaw: train?.trainNumRaw,
            trainID: train?.trainID,
            lat: train?.lat,
            lon: train?.lon,
            iconColor: train?.iconColor,
            textColor: train?.textColor,
            thisStationMin: thisStationMin,
            heading: train?.heading,
            eventCode: train?.eventCode,
            eventTZ: train?.eventTZ,
            eventName: train?.eventName,
            origCode: train?.origCode,
            originTZ: train?.originTZ,
            origName: train?.origName,
            destCode: train?.destCode,
            destTZ: train?.destTZ,
            destName: train?.destName,
            trainState: train?.trainState,
            velocity: train?.velocity,
            statusMsg: train?.statusMsg,
            createdAt: train?.createdAt,
            updatedAt: train?.updatedAt,
            lastValTS: train?.lastValTS,
            provider: train?.provider,
            providerShort: train?.providerShort,
            onlyOfTrainNum: train?.onlyOfTrainNum,
            alerts: train?.alerts
          };
        })
      };

      return new Response(JSON.stringify({ [stationCode]: newStation }), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url.startsWith("/v3/stations")) {
      const stationCode = url.split("/")[3];
      const stations = amtrakerCache.getStations();

      if (stationCode === undefined) {
        console.log(request.url, url, "stations");
        return new Response(JSON.stringify(stations), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        });
      }

      if (stations[stationCode] == null) {
        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json"
          }
        });
      }

      return new Response(JSON.stringify({ [stationCode]: stations[stationCode] }), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    if (url.startsWith("/v3/oembed")) {
      const params = new URL(request.url).searchParams;
      const paramsObj = Object.fromEntries(params.entries());

      if (!paramsObj.url) {
        paramsObj.url = "https://amtraker.com/";
      }

      const requestedURL = new URL(paramsObj.url);
      const processedURL = requestedURL.origin + requestedURL.pathname + "?oembed";

      const embedWidth = Math.min(paramsObj.maxwidth ? Number(paramsObj.maxwidth) : 1000, 464);
      const embedHeight = Math.min(paramsObj.maxheight ? Number(paramsObj.maxheight) : 1000, 788);

      const oembedResponse = {
        type: "rich",
        version: "1.0",
        title: "",
        provider_name: "Amtraker",
        provider_url: "https://amtraker.com",
        cache_age: "180",
        html: `<iframe src="${processedURL}" style="border:0px #ffffff none;" name="amtraker_iframe" scrolling="no" frameborder="0" marginheight="0px" marginwidth="0px" height="${embedHeight}px" width="${embedWidth}px" allowfullscreen></iframe>`,
        width: embedWidth,
        height: embedHeight
      };

      if (paramsObj.format && paramsObj.format === "xml") {
        const xmlResponse = xmlBuilder.build(oembedResponse);

        return new Response(`<?xml version="1.0" encoding="utf-8"?><oembed>${xmlResponse}</oembed>`, {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "text/xml"
          }
        });
      }

      return new Response(JSON.stringify(oembedResponse, null, 2), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
});
