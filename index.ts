// so much goop god this needs a hell of a rewrite

import moment from "moment-timezone";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";

const xmlBuilder = new XMLBuilder();

import { RawStation } from "./types/amtrak";
import {
  Train,
  Station,
  StationStatus,
  TrainResponse,
  StationResponse,
} from "./types/amtraker";

import { trainNames, viaTrainNames } from "./data/trains";
import * as stationMetaData from "./data/stations";
import { amtrakStationCodeReplacements } from './data/sharedStations';
import cache from "./cache";

const rawStations = JSON.parse(fs.readFileSync("./rawStations.json", { encoding: "utf8" }));

import calculateIconColor from "./calculateIconColor";

let lastUpdatedTime = {
  updatedAt: 0,
  updatedAtISO: "1970-01-01T00:00:00.000Z",
  updatedAtChicagoPlain: "Wednesday, December 31, 1969 at 6:00:00 PM CST",
};

let staleData = {
  avgLastUpdate: 0,
  activeTrains: 0,
  stale: false,
};

let shitsFucked = false;

const amtrakerCache = new cache();
let decryptedTrainData = "";
let decryptedStationData = "";
let AllTTMTrains = "";
let trainPlatforms = {};
let brightlineData = {};
let brightlinePlatforms = {};

//https://stackoverflow.com/questions/196972/convert-string-to-title-case-with-javascript
const title = (str: string) => {
  return str.replace(
    /\w\S*/g,
    (text) => text.charAt(0).toUpperCase() + text.substring(1).toLowerCase()
  );
};

const ccDegToCardinal = (deg) => {
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

  if (badDate == null || code == null) return null;

  //first is standard time, second is daylight savings
  const offsets = {
    "America/New_York": ["-05:00", "-04:00"],
    "America/Detroit": ["-05:00", "-04:00"],
    "America/Chicago": ["-06:00", "-05:00"],
    "America/Denver": ["-07:00", "-06:00"],
    "America/Phoenix": ["-07:00", "-07:00"],
    "America/Los_Angeles": ["-08:00", "-07:00"],
    "America/Boise": ["-07:00", "-06:00"],
    "America/Toronto": ["-05:00", "-04:00"],
    "America/Indiana/Indianapolis": ["-05:00", "-04:00"],
    "America/Kentucky/Louisville": ["-05:00", "-04:00"],
    "America/Vancouver": ["-08:00", "-07:00"],
  };

  const timeZone = stationMetaData.timeZones[code] ?? "America/New_York";

  try {
    const dateArr = badDate.split(" ");
    let MDY = dateArr[0].split("/").map((num) => Number(num));
    let HMS = dateArr[1].split(":").map((num) => Number(num));

    if (dateArr.length == 3 && dateArr[2] == "PM") {
      HMS[0] += 12; //adds 12 hour difference for time zone
    }

    if (dateArr.length == 3 && dateArr[2] == "AM" && HMS[0] == 12) {
      HMS[0] = 0; //12 AM is 0 hour
    }

    if (HMS[0] == 24) {
      HMS[0] = 12;
      //edge case for 12:00pm - 12:59pm
    }

    const month = MDY[0].toString().padStart(2, "0");
    const date = MDY[1].toString().padStart(2, "0");
    const year = MDY[2].toString().padStart(4, "0");

    const hour = HMS[0].toString().padStart(2, "0");
    const minute = HMS[1].toString().padStart(2, "0");
    const second = HMS[2].toString().padStart(2, "0");

    const now = new Date();
    const nowYear = now.getFullYear();
    let dst_start = new Date(nowYear, 2, 14);
    let dst_end = new Date(nowYear, 10, 7);
    dst_start.setDate(14 - dst_start.getDay()); // adjust date to 2nd Sunday
    dst_end.setDate(7 - dst_end.getDay()); // adjust date to the 1st Sunday

    const isDST = Number(now >= dst_start && now < dst_end);

    return `${year}-${month}-${date}T${hour}:${minute}:${second}${offsets[timeZone][isDST]}`;
  } catch (e) {
    console.log("Couldn't parse date:", badDate, code);
    return null;
  }
};

const parseRawStation = (rawStation: RawStation, rawTrainNum: String = "", debug: boolean = false) => {
  let status: StationStatus;
  let arr: string;
  let dep: string;

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

  return {
    name: stationMetaData.stationNames[rawStation.code],
    code: actualCode,
    tz: stationMetaData.timeZones[rawStation.code],
    bus: rawStation.bus,
    schArr:
      parseDate(rawStation.scharr, rawStation.code) ??
      parseDate(rawStation.schdep, rawStation.code),
    schDep:
      parseDate(rawStation.schdep, rawStation.code) ??
      parseDate(rawStation.scharr, rawStation.code),
    arr: arr ?? dep,
    dep: dep ?? arr,
    arrCmnt: "",
    depCmnt: "",
    status: status,
    stopIconColor: "#212529",
    platform: trainPlatforms[rawStation.code] && trainPlatforms[rawStation.code][rawTrainNum] ? trainPlatforms[rawStation.code][rawTrainNum] : "",
  } as Station
};

const updateTrains = async () => {
  console.log("Updating trains...");
  shitsFucked = false;

  const platformRes = await fetch("https://platformsapi.amtraker.com/stations");
  try {
    trainPlatforms = await platformRes.json();
  } catch (e) {
    trainPlatforms = {};
  }

  const amtrakAlertsData = await fetch("https://store.transitstat.us/amtrak_alerts" + (process.env.SUPER_SECRET_CACHE_BUSTING ?? '')).then((res) => res.json());

  const brightlineRes = await fetch('https://store.transitstat.us/brightline' + (process.env.SUPER_SECRET_CACHE_BUSTING ?? ''));
  const rawBrightline = await brightlineRes.json();
  brightlineData = rawBrightline['v1'];
  brightlinePlatforms = rawBrightline['platforms'];

  let trains: TrainResponse = {};
  let allStations: StationResponse = {};

  const allProxiedData: any = await fetch("https://store.transitstat.us/amtrak_fetch_proxy" + (process.env.SUPER_SECRET_CACHE_BUSTING ?? '')).then((res) => res.json());
  const viaData = allProxiedData.trainDataVIA;
  const stationData = allProxiedData.trainStations.features.length > 0 ?
    allProxiedData.trainStations.features :
    rawStations.features;
  const amtrakData = allProxiedData.trainDataMain.features;
  AllTTMTrains = JSON.stringify(allProxiedData.trainDataASMAD);
  lastUpdatedTime = allProxiedData.updatedTime;
  decryptedTrainData = JSON.stringify(amtrakData);
  decryptedStationData = JSON.stringify(stationData);

  const cpkcHolidayTrainData: any = await fetch("https://store.transitstat.us/cpkc_holiday" + (process.env.SUPER_SECRET_CACHE_BUSTING ?? '')).then((res) => res.json());

  console.log("fetched s");
  stationData.forEach((station) => {
    const actualCode = amtrakStationCodeReplacements[station.properties.Code] ?? station.properties.Code;

    const stationObj = {
      name: stationMetaData.stationNames[station.properties.Code],
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
      trains: [],
    };

    if (!allStations[actualCode]) allStations[actualCode] = stationObj;
    amtrakerCache.setStation(actualCode, stationObj);
  });

  console.log("fetched t");
  const nowCleaning: number = new Date().valueOf();

  staleData.activeTrains = 0;
  staleData.avgLastUpdate = 0;
  staleData.stale = false;

  Object.keys(cpkcHolidayTrainData.trains).forEach((trainKey) => {
    const trainData = cpkcHolidayTrainData.trains[trainKey];

    let train: Train = {
      routeName: `CP ${trainData.line} Holiday`,
      trainNum: `CP${trainKey}`,
      trainNumRaw: trainKey,
      trainID: `CP${trainKey}-25`,
      lat: trainData.lat,
      lon: trainData.lon,
      trainTimely: "",
      iconColor: '#a80000',
      textColor: '#ffffff',
      stations: trainData.predictions.sort((a, b) => a.rawETA - b.rawETA).map((prediction) => {
        const stationMeta = cpkcHolidayTrainData.stations[prediction.stationID];

        if (!allStations[prediction.stationID]) {
          allStations[prediction.stationID] = {
            name: prediction.stationName,
            code: prediction.stationID,
            tz: prediction.tz,
            lat: stationMeta.lat,
            lon: stationMeta.lon,
            hasAddress: false,
            address1: "",
            address2: "",
            city: "",
            state: "",
            zip: "",
            trains: [],
          }
        }

        allStations[prediction.stationID].trains.push(`CP${trainKey}-25`);

        const arr = new Date(prediction.arr ?? prediction.dep);
        const dep = new Date(prediction.dep ?? prediction.arr);

        const arrString = arr.toISOString();
        const depString = dep.toISOString();

        const arrNum = arr.valueOf();
        const depNum = arr.valueOf();

        const now = Date.now();

        return {
          name: prediction.stationName,
          code: prediction.stationID,
          tz: "America/Chicago",
          bus: false,
          schArr: arrString,
          schDep: depString,
          arr: arrString,
          dep: depString,
          arrCmnt: "",
          depCmnt: "",
          status: now < arrNum ? "Enroute" : (
            now > arrNum && now < depNum ? "Station" : "Departed"
          ),
          stopIconColor: "#267300",
          platform: ""
        };
      }),
      heading: trainData.headingLetter,
      eventCode: 'CPKC',
      eventTZ: 'America/Chicago',
      eventName: 'Christmas',
      origCode: 'CPKC',
      originTZ: 'America/Chicago',
      origName: 'Christmas',
      destCode: 'CPKC',
      destTZ: 'America/Chicago',
      destName: 'Christmas',
      trainState: "Active",
      velocity: 0, // no data unfortunately
      statusMsg: " ",
      createdAt: cpkcHolidayTrainData['lastUpdated'] ?? new Date().toISOString(),
      updatedAt: cpkcHolidayTrainData['lastUpdated'] ?? new Date().toISOString(),
      lastValTS: cpkcHolidayTrainData['lastUpdated'] ?? new Date().toISOString(),
      objectID: Number(trainKey),
      provider: "Canadian Pacific Kansas City",
      providerShort: "CPKC",
      onlyOfTrainNum: true,
      alerts: [],
    };

    const firstStation = train.stations[0];
    const lastStation = train.stations[train.stations.length - 1];
    const upcomingStation = train.stations.find((station) => station.status == 'Enroute' || station.status == 'Station') ?? lastStation;

    train.origCode = firstStation.code;
    train.originTZ = firstStation.tz;
    train.origName = firstStation.name;
    train.eventCode = upcomingStation.code;
    train.eventName = upcomingStation.name;
    train.eventTZ = upcomingStation.tz;
    train.destCode = lastStation.code;
    train.destName = lastStation.name;
    train.destTZ = lastStation.tz;

    train.stations.push({
      name: "Christmas",
      code: "CPKC",
      tz: "America/Chicago",
      bus: false,
      schArr: "2025-12-25T00:00:00-06:00",
      schDep: "2025-12-25T00:00:00-06:00",
      arr: "2025-12-25T00:00:00-06:00",
      dep: "2025-12-25T00:00:00-06:00",
      arrCmnt: "",
      depCmnt: "",
      status: "Enroute",
      stopIconColor: "#267300",
      platform: ""
    });

    if (!allStations['CPKC']) {
      allStations['CPKC'] = {
        name: 'Christmas',
        code: 'CPKC',
        tz: 'America/Chicago',
        lat: 83.29825041784702,
        lon: -34.49599261128057,
        hasAddress: true,
        address1: "This is a work in progress, actual stop times are coming.",
        address2: "",
        city: "",
        state: "",
        zip: "",
        trains: [],
      }
    }

    allStations['CPKC'].trains.push(`CP${trainKey}-25`);

    trains[`CP${trainKey}`] = [train];
  });

  Object.keys(brightlineData['trains']).forEach((trainNum) => {
    const rawTrainData = brightlineData['trains'][trainNum];

    if (!rawTrainData.realTime) return; // train is scheduled and should not be shown on Amtraker

    const firstStation = rawTrainData['predictions'][0];
    const lastStation = rawTrainData['predictions'].slice(-1)[0];
    const trainEventStation = rawTrainData['predictions'].filter((station) => station.dep >= Date.now())[0] ?? lastStation;

    let train: Train = {
      routeName: 'Brightline',
      trainNum: 'b' + trainNum,
      trainNumRaw: trainNum,
      trainID: 'b' + trainNum + '-' + new Date(firstStation.dep).getDate(),
      lat: rawTrainData['lat'],
      lon: rawTrainData['lon'],
      trainTimely: "",
      iconColor: "#212529",
      textColor: "#ffffff",
      stations: rawTrainData.predictions.map((prediction) => {
        const actualID = 'B' + prediction.stationID;
        if (!allStations[actualID]) {
          allStations[actualID] = {
            name: prediction.stationName,
            code: actualID,
            tz: prediction.tz,
            lat: brightlineData['stations'][prediction['stationID']]['lat'],
            lon: brightlineData['stations'][prediction['stationID']]['lon'],
            hasAddress: false,
            address1: "",
            address2: "",
            city: "",
            state: "",
            zip: "",
            trains: [],
          }
        }

        allStations[actualID].trains.push(
          'b' + trainNum + '-' + new Date(firstStation.dep).getDate()
        );

        return {
          name: prediction['stationName'],
          code: actualID,
          tz: prediction['tz'],
          bus: false,
          schArr: new Date(prediction['arr'] - prediction['arrDelay']).toISOString(),
          schDep: new Date(prediction['dep'] - prediction['depDelay']).toISOString(),
          arr: new Date(prediction['arr']).toISOString(),
          dep: new Date(prediction['dep']).toISOString(),
          arrCmnt: "",
          depCmnt: "",
          status: prediction['dep'] > Date.valueOf() ? "Departed" : "Enroute",
          stopIconColor: "#212529",
          platform: brightlinePlatforms[prediction.stationID] && brightlinePlatforms[prediction.stationID][trainNum] ? brightlinePlatforms[prediction.stationID][trainNum] : "",
        };
      }),
      heading: ccDegToCardinal(rawTrainData.heading),
      eventCode: 'B' + trainEventStation.stationID,
      eventTZ: trainEventStation.tz,
      eventName: trainEventStation.stationName,
      origCode: 'B' + firstStation.stationID,
      originTZ: firstStation.tz,
      origName: firstStation.stationName,
      destCode: 'B' + lastStation.stationID,
      destTZ: lastStation.tz,
      destName: lastStation.stationName,
      trainState: "Active",
      velocity: 0, // no data unfortunately
      statusMsg: " ",
      createdAt: brightlineData['lastUpdated'] ?? new Date().toISOString(),
      updatedAt: brightlineData['lastUpdated'] ?? new Date().toISOString(),
      lastValTS: brightlineData['lastUpdated'] ?? new Date().toISOString(),
      objectID: Number(trainNum),
      provider: "Brightline",
      providerShort: "BLNE",
      onlyOfTrainNum: true,
      alerts: [],
    };

    const calculatedColors = calculateIconColor(train, allStations);
    train.iconColor = calculatedColors['color'];
    train.textColor = calculatedColors['text'];
    train.stations = train.stations.map((stationRaw) => {
      return {
        ...stationRaw,
        stopIconColor: calculateIconColor(train, allStations, stationRaw.code)['color'],
      }
    });

    if (!trains['b' + trainNum]) trains['b' + trainNum] = [];
    trains['b' + trainNum].push(train);

    if (train.trainState === "Active") {
      staleData.avgLastUpdate +=
        nowCleaning - new Date(train.lastValTS).valueOf();
      staleData.activeTrains++;
    }
  })

  Object.keys(viaData).forEach((trainNum) => {
    const rawTrainData = viaData[trainNum];
    const actualTrainNum = "v" + trainNum.split(" ")[0];
    if (!rawTrainData.departed) return; //train doesn't exist
    if (actualTrainNum == "97" || actualTrainNum == "98") return; //covered by amtrak

    const sortedStations = rawTrainData.times.sort(
      (a, b) =>
        new Date(a.scheduled).valueOf() -
        new Date(b.scheduled).valueOf()
    );

    const firstStation = sortedStations[0];
    const lastStation = sortedStations[sortedStations.length - 1];
    const trainEventStation =
      sortedStations.find((station) => station.eta !== "ARR") ??
      firstStation;

    let trainDelay = 0;

    let train: Train = {
      routeName:
        viaTrainNames[trainNum.split(" ")[0]] ??
        `${title(rawTrainData.from)}-${title(rawTrainData.to)}`,
      trainNum: `${actualTrainNum}`,
      trainNumRaw: trainNum.split(" ")[0],
      trainID: `${actualTrainNum}-${Number(rawTrainData.instance.split("-")[2])}`,
      lat:
        rawTrainData.lat ??
        stationMetaData.viaCoords[trainEventStation.code][0],
      lon:
        rawTrainData.lng ??
        stationMetaData.viaCoords[trainEventStation.code][1],
      trainTimely: "",
      iconColor: '#212529',
      textColor: '#ffffff',
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
            trains: [],
          };
        }

        allStations[station.code].trains.push(`${actualTrainNum}-${Number(rawTrainData.instance.split("-")[2])}`);

        if (station.arrival && station.arrival.estimated) {
          trainDelay =
            new Date(station.arrival.estimated).valueOf() -
            new Date(station.arrival.scheduled).valueOf();
        }

        const estArr = (station.arrival ?? station.departure)
          .estimated;
        const estDep = (station.departure ?? station.arrival)
          .estimated;

        return {
          name: stationMetaData.viaStationNames[station.code],
          code: station.code,
          tz: stationMetaData.viatimeZones[station.code],
          bus: false,
          schArr: (station.arrival ?? station.departure).scheduled,
          schDep: (station.departure ?? station.arrival).scheduled,
          arr:
            estArr ??
            new Date(
              new Date(
                (station.arrival ?? station.departure).scheduled
              ).valueOf() + trainDelay
            ),
          dep:
            estDep ??
            new Date(
              new Date(
                (station.departure ?? station.arrival).scheduled
              ).valueOf() + trainDelay
            ),
          arrCmnt: "",
          depCmnt: "",
          status: station.eta === "ARR" ? "Departed" : "Enroute",
          stopIconColor: "#212529",
          platform: "",
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
      alerts: [],
    };

    const calculatedColors = calculateIconColor(train, allStations);
    train.iconColor = calculatedColors['color'];
    train.textColor = calculatedColors['text'];
    train.stations = train.stations.map((stationRaw) => {
      return {
        ...stationRaw,
        stopIconColor: calculateIconColor(train, allStations, stationRaw.code)['color'],
      }
    });

    if (!trains[actualTrainNum]) trains[actualTrainNum] = [];
    trains[actualTrainNum].push(train);

    if (train.trainState === "Active") {
      staleData.avgLastUpdate +=
        nowCleaning - new Date(train.lastValTS).valueOf();
      staleData.activeTrains++;
    }
  });

  amtrakData.forEach((property) => {
    let rawTrainData = property.properties;

    let rawStations: Array<RawStation> = [];

    for (let i = 1; i < 47; i++) {
      let station = rawTrainData[`Station${i}`];
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
            trains: [],
          });
        }
      }

      const result = parseRawStation(station, rawTrainData.TrainNum); //, rawTrainData.TrainNum == "784");

      return result;
    });

    if (stations.length === 0) {
      console.log(
        "No stations found for train:",
        rawTrainData.TrainNum
      );
      return;
    }

    const enrouteStations = stations.filter(
      (station) =>
        (station.status === "Enroute" ||
          station.status === "Station") &&
        (station.arr || station.dep)
    );

    const trainEventCode = enrouteStations.length == 0 ? stations[stations.length - 1].code : enrouteStations[0].code;
    const actualTrainEventCode = amtrakStationCodeReplacements[trainEventCode] ?? trainEventCode;
    const actualOrigCode = amtrakStationCodeReplacements[rawTrainData.OrigCode] ?? rawTrainData.OrigCode;
    const actualDestCode = amtrakStationCodeReplacements[rawTrainData.DestCode] ?? rawTrainData.DestCode;

    // i hate this more than you do
    const originDateOfMonth = new Intl.DateTimeFormat('en-US',
      {
        timeZone: stationMetaData.timeZones[rawTrainData.OrigCode],
        day: 'numeric'
      })
      .format(new Date(
        stations[0].schDep));

    let train: Train = {
      routeName: trainNames[+rawTrainData.TrainNum]
        ? trainNames[+rawTrainData.TrainNum]
        : rawTrainData.RouteName,
      trainNum: `${+rawTrainData.TrainNum}`,
      trainNumRaw: `${+rawTrainData.TrainNum}`,
      trainID: `${+rawTrainData.TrainNum}-${originDateOfMonth}`,
      lat: property.geometry.coordinates[1],
      lon: property.geometry.coordinates[0],
      trainTimely: "",
      iconColor: "#212529",
      textColor: "#ffffff",
      stations: stations,
      heading: rawTrainData.Heading ? rawTrainData.Heading : "N",
      eventCode: actualTrainEventCode,
      eventTZ: stationMetaData.timeZones[trainEventCode],
      eventName: stationMetaData.stationNames[trainEventCode],
      origCode: actualOrigCode,
      originTZ: stationMetaData.timeZones[rawTrainData.OrigCode],
      origName: stationMetaData.stationNames[rawTrainData.OrigCode],
      destCode: actualDestCode,
      destTZ: stationMetaData.timeZones[rawTrainData.DestCode],
      destName: stationMetaData.stationNames[rawTrainData.DestCode],
      trainState: rawTrainData.TrainState,
      velocity: +rawTrainData.Velocity,
      statusMsg:
        stations.filter(
          (station) =>
            !station.arr &&
            !station.dep &&
            station.code === trainEventCode
        ).length > 0
          ? "SERVICE DISRUPTION"
          : rawTrainData.StatusMsg,
      createdAt:
        parseDate(rawTrainData.created_at, "America/New_York") ??
        parseDate(rawTrainData.updated_at, "America/New_York"),
      updatedAt:
        parseDate(rawTrainData.updated_at, "America/New_York") ??
        parseDate(rawTrainData.created_at, "America/New_York"),
      lastValTS:
        parseDate(rawTrainData.LastValTS, trainEventCode) ??
        stations[0].schDep,
      objectID: rawTrainData.OBJECTID,
      provider: "Amtrak",
      providerShort: "AMTK",
      onlyOfTrainNum: true,
      alerts: amtrakAlertsData['trains'][`${+rawTrainData.TrainNum}-${originDateOfMonth}`] ?? [],
    };

    const calculatedColors = calculateIconColor(train, allStations);
    train.iconColor = calculatedColors['color'];
    train.textColor = calculatedColors['text'];
    train.stations = train.stations.map((stationRaw) => {
      return {
        ...stationRaw,
        stopIconColor: calculateIconColor(train, allStations, stationRaw.code)['color'],
      }
    });

    if (!trains[rawTrainData.TrainNum]) trains[rawTrainData.TrainNum] = [];
    trains[rawTrainData.TrainNum].push(train);

    if (train.trainState === "Active") {
      staleData.avgLastUpdate +=
        nowCleaning - new Date(train.lastValTS).valueOf();
      staleData.activeTrains++;
    }
  });

  // setting onlyOfTrainNum and deduplicating at the same time
  Object.keys(trains).forEach((trainNum) => {
    // deduplicating trains with the same ID
    let trainIDs = [];
    trains[trainNum] = trains[trainNum].filter((train) => {
      if (trainIDs.includes(train.trainID)) return false;
      trainIDs.push(train.trainID);
      return true;
    });

    // setting onlyOfTrainNum 
    trains[trainNum].forEach((train, i, arr) => {
      trains[trainNum][i].onlyOfTrainNum = arr.length <= 1; // this should be an == but edge cases be damned
    });
  })

  staleData.avgLastUpdate =
    staleData.avgLastUpdate / staleData.activeTrains;

  if (staleData.avgLastUpdate > 1000 * 60 * 20) {
    console.log("Data is stale, setting...");
    staleData.stale = true;
  }

  Object.keys(allStations).forEach((stationKey) => {
    amtrakerCache.setStation(stationKey, allStations[stationKey]);
  });

  amtrakerCache.setTrains(trains);
  console.log("set trains cache");




};

updateTrains();

setInterval(() => updateTrains(), 1000 * 15); // every 15 seconds

Bun.serve({
  port: process.env.PORT ?? 3001,
  fetch(request) {
    let url = new URL(request.url).pathname;

    console.log(request.url);
    console.log(url);

    if (url.startsWith("/v2")) {
      url = url.replace("/v2", "/v3");
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
          shitsFucked,
          staleData,
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        }
      );
    }

    if (url === '/v3/times') {
      return new Response(
        JSON.stringify(lastUpdatedTime),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        }
      );
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
      return new Response(shitsFucked.toString(), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/raw") {
      return new Response(decryptedTrainData, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/rawStations") {
      return new Response(decryptedStationData, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/AllTTMTrains") {
      return new Response(AllTTMTrains, {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/stale") {
      return new Response(JSON.stringify(staleData), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url.startsWith("/v3/ids")) {
      console.log("train ids");
      const trainIDs = amtrakerCache.getIDs();
      return new Response(JSON.stringify(trainIDs), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url.startsWith("/v3/trains")) {
      const trainNum = url.split("/")[3];

      const trains = amtrakerCache.getTrains();

      if (trainNum === undefined) {
        console.log("all trains");
        return new Response(JSON.stringify(trains), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      if (trainNum === "arr") {
        console.log("all trains in an array");
        return new Response(
          JSON.stringify({
            0: Object.values(trains).flatMap((n) => n),
          }),
          {
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "application/json",
            },
          }
        );
      }

      console.log("train num", trainNum);

      if (trainNum.split("-").length === 2) {
        const trainsArr = trains[trainNum.split("-")[0]];

        if (trainsArr == undefined) {
          return new Response(JSON.stringify([]), {
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "application/json",
            },
          });
        }

        for (let i = 0; i < trainsArr.length; i++) {
          if (trainsArr[i].trainID === trainNum) {
            return new Response(
              JSON.stringify({ [trainNum.split("-")[0]]: [trainsArr[i]] }),
              {
                headers: {
                  "Access-Control-Allow-Origin": "*", // CORS
                  "content-type": "application/json",
                },
              }
            );
          }
        }

        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      if (trains[trainNum] == null) {
        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      return new Response(
        JSON.stringify({
          [trainNum]: trains[trainNum],
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        }
      );
    }

    if (url.startsWith("/v3/stations")) {
      const stationCode = url.split("/")[3];
      const stations = amtrakerCache.getStations();

      if (stationCode === undefined) {
        console.log("stations");
        return new Response(JSON.stringify(stations), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      if (stations[stationCode] == null) {
        return new Response(JSON.stringify([]), {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        });
      }

      return new Response(
        JSON.stringify({
          [stationCode]: stations[stationCode],
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*", // CORS
            "content-type": "application/json",
          },
        }
      );
    }

    if (url.startsWith("/v3/oembed")) {
      const params = new URL(request.url).searchParams;
      const paramsObj = Object.fromEntries(params.entries());

      if (!paramsObj.url) { paramsObj.url = 'https://amtraker.com/' };

      const requestedURL = new URL(paramsObj.url);
      const processedURL =
        requestedURL.origin + requestedURL.pathname + "?oembed";

      const embedWidth = Math.min(
        paramsObj.maxwidth ? Number(paramsObj.maxwidth) : 1000,
        464
      );
      const embedHeight = Math.min(
        paramsObj.maxheight ? Number(paramsObj.maxheight) : 1000,
        788
      );

      const oembedResponse = {
        type: "rich",
        version: "1.0",
        title: "",
        provider_name: "Amtraker",
        provider_url: "https://amtraker.com",
        cache_age: "180",
        html: `<iframe src="${processedURL}" style="border:0px #ffffff none;" name="amtraker_iframe" scrolling="no" frameborder="0" marginheight="0px" marginwidth="0px" height="${embedHeight}px" width="${embedWidth}px" allowfullscreen></iframe>`,
        width: embedWidth,
        height: embedHeight,
      };

      if (paramsObj.format && paramsObj.format === "xml") {
        const xmlResponse = xmlBuilder.build(oembedResponse);

        return new Response(
          `<?xml version="1.0" encoding="utf-8"?><oembed>${xmlResponse}</oembed>`,
          {
            headers: {
              "Access-Control-Allow-Origin": "*", // CORS
              "content-type": "text/xml+oembed",
            },
          }
        );
      }

      return new Response(JSON.stringify(oembedResponse, null, 2), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json+oembed",
        },
      });
    }

    return new Response("Not found", {
      status: 404,
    });
  },
});
