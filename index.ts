import * as crypto from "crypto-js";
import moment from "moment-timezone";
import * as schedule from "node-schedule";
import * as fs from "fs";

import { Amtrak, RawStation } from "./types/amtrak";
import {
  Train,
  Station,
  StationStatus,
  TrainResponse,
  StationResponse,
} from "./types/amtraker";

import { trainNames } from "./data/trains";
import * as stationMetaData from "./data/stations";
import cache from "./cache";

import length from "@turf/length";
import along from "@turf/along";

const snowPiercerShape = JSON.parse(
  fs.readFileSync("./snowPiercer.json", "utf8")
);
const snowPiercerShapeLength = length(snowPiercerShape);

const calculateSnowPiercerPosition = (time: Date) => {
  const timesAround = Math.abs(
    Number(
      (
        ((time.valueOf() -
          new Date(new Date().toISOString().split("T")[0]).getTime()) /
          (1000 * 60 * 60 * 6)) %
        1
      ).toFixed(4)
    )
  );
  const distanceOnShape = snowPiercerShapeLength * timesAround;

  const point = along(snowPiercerShape, distanceOnShape);

  return point;
};

let staleData = {
  avgLastUpdate: 0,
  activeTrains: 0,
  stale: false,
};

let shitsFucked = false;

const trainUrl =
  "https://maps.amtrak.com/services/MapDataService/trains/getTrainsData";
const stationUrl =
  "https://maps.amtrak.com/services/MapDataService/stations/trainStations";
const sValue = "9a3686ac";
const iValue = "c6eb2f7f5c4740c1a2f708fefd947d39";
const publicKey = "69af143c-e8cf-47f8-bf09-fc1f61e5cc33";
const masterSegment = 88;

const amtrakerCache = new cache();
let decryptedTrainData = {};

const decrypt = (content, key) => {
  return crypto.AES.decrypt(
    crypto.lib.CipherParams.create({
      ciphertext: crypto.enc.Base64.parse(content),
    }),
    crypto.PBKDF2(key, crypto.enc.Hex.parse(sValue), {
      keySize: 4,
      iterations: 1e3,
    }),
    { iv: crypto.enc.Hex.parse(iValue) }
  ).toString(crypto.enc.Utf8);
};

const fetchTrainsForCleaning = async () => {
  const response = await fetch(trainUrl);
  const data = await response.text();

  const mainContent = data.substring(0, data.length - masterSegment);
  const encryptedPrivateKey = data.substr(
    data.length - masterSegment,
    data.length
  );
  const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];

  const decryptedData = JSON.parse(decrypt(mainContent, privateKey));
  decryptedTrainData = decryptedData;

  return decryptedData.features;
};

const fetchStationsForCleaning = async () => {
  const response = await fetch(stationUrl);
  const data = await response.text();

  const mainContent = data.substring(0, data.length - masterSegment);
  const encryptedPrivateKey = data.substr(
    data.length - masterSegment,
    data.length
  );
  const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];
  const decrypted = decrypt(mainContent, privateKey);

  return decrypted.length > 0
    ? JSON.parse(decrypted)?.StationsDataResponse?.features
    : [];
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

const generateCmnt = (
  scheduledDate: string,
  actualDate: string,
  code: string
) => {
  let parsedScheduledDate = parseDate(scheduledDate, code);
  let parsedActualDate = parseDate(actualDate, code);
  let earlyOrLate = moment(parsedScheduledDate).isBefore(parsedActualDate)
    ? "Late"
    : "Early";

  let diff = moment(parsedActualDate).diff(parsedScheduledDate);

  let duration = moment.duration(diff);
  let hrs = duration.hours(),
    mins = duration.minutes();

  let string =
    (hrs > 0 ? Math.abs(hrs) + " Hours, " : "") +
    (Math.abs(mins) + " Minutes ");

  if (mins < 5 && earlyOrLate === "Late") {
    return "On Time";
  } else {
    return string + earlyOrLate;
  }
};

const parseRawStation = (rawStation: RawStation) => {
  let status: StationStatus;
  let arr: string;
  let dep: string;
  let arrCmnt: string;
  let depCmnt: string;

  if (rawStation.estarr == null && rawStation.postarr == null) {
    // is this the first station
    if (rawStation.postdep != null) {
      // if the train has departed
      //console.log("has departed first station");
      status = StationStatus.Departed;
      dep = parseDate(rawStation.postdep, rawStation.code);
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.postdep,
        rawStation.code
      );
    } else {
      // if the train hasn't departed
      //console.log("has not departed first station");
      status = StationStatus.Station;
      dep = parseDate(rawStation.estdep, rawStation.code);
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.estdep,
        rawStation.code
      );
    }
  } else if (rawStation.postarr == null) {
    // is this the last station
    if (rawStation.postarr != null) {
      // if the train has arrived
      //console.log("has arrived last station");
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr,
        rawStation.postarr,
        rawStation.code
      );
    } else {
      // if the train is enroute
      //console.log("enroute to last station");
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr,
        rawStation.estarr,
        rawStation.code
      );
    }
  } else {
    // for all other stations
    if (rawStation.estarr != null && rawStation.estdep != null) {
      // if the train is enroute
      //console.log("enroute");
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr ?? rawStation.schdep,
        rawStation.estarr,
        rawStation.code
      );
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.estdep,
        rawStation.code
      );
    } else if (rawStation.postarr != null && rawStation.estdep != null) {
      // if the train has arrived but not departed
      //console.log("not departed");
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr ?? rawStation.schdep,
        rawStation.postarr,
        rawStation.code
      );
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.estdep,
        rawStation.code
      );
    } else if (rawStation.postdep != null || rawStation.postcmnt != null) {
      // if the train has departed
      //console.log("has departed");
      status = StationStatus.Departed;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.postdep, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr ?? rawStation.schdep,
        rawStation.postarr,
        rawStation.code
      );
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.postdep,
        rawStation.code
      );
    } else {
      //console.log("wtf goin on??????");
      //console.log(rawStation);
    }
  }

  return {
    name: stationMetaData.stationNames[rawStation.code],
    code: rawStation.code,
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
    arrCmnt: arrCmnt ?? depCmnt,
    depCmnt: depCmnt ?? arrCmnt,
    status: status,
  } as Station;
};

const updateTrains = async () => {
  let stations: StationResponse = {};
  console.log("Updating trains...");
  shitsFucked = false;
  fetchStationsForCleaning()
    .then((stationData) => {
      /*
      stationData.forEach((station) => {
        amtrakerCache.setStation(station.properties.Code, {
          name: stationMetaData.stationNames[station.properties.Code],
          code: station.properties.Code,
          tz: stationMetaData.timeZones[station.properties.Code],
          lat: station.properties.lat,
          lon: station.properties.lon,
          address1: station.properties.Address1,
          address2: station.properties.Address2,
          city: station.properties.City,
          state: station.properties.State,
          zip: station.properties.Zipcode,
          trains: [],
        });
      });
      */

      /*
      //SNOWPIERCER
      amtrakerCache.setStation("EARTH", {
        name: "Earth",
        code: "EARTH",
        tz: "America/Chicago",
        lat: 0,
        lon: 0,
        address1: "123 Null Island",
        address2: " ",
        city: "Everywhere",
        state: "US",
        zip: 30327,
        trains: [],
      });
      */

      fetchTrainsForCleaning()
        .then((amtrakData) => {
          const nowCleaning: number = new Date().valueOf();

          staleData.activeTrains = 0;
          staleData.avgLastUpdate = 0;
          staleData.stale = false;

          let trains: TrainResponse = {};
          let allStations: StationResponse = {};

          amtrakData.forEach((property) => {
            let rawTrainData = property.properties;
            //console.log(property)

            let rawStations: Array<RawStation> = [];

            for (let i = 1; i < 41; i++) {
              let station = rawTrainData[`Station${i}`];
              if (station == undefined) {
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
              if (!allStations[station.code]) {
                amtrakerCache.setStation(station.code, {
                  name: stationMetaData.stationNames[station.code],
                  code: station.code,
                  tz: stationMetaData.timeZones[station.code],
                  lat: 0,
                  lon: 0,
                  address1: "ADDRESS1",
                  address2: "ADDRESS2",
                  city: "CITY",
                  state: "STATE",
                  zip: 0,
                  trains: [],
                });
              }

              const result = parseRawStation(station);

              return result;
            });

            if (stations.length === 0) {
              console.log(
                "No stations found for train:",
                rawTrainData.TrainNum
              );
              return;
            }

            let train: Train = {
              routeName: trainNames[+rawTrainData.TrainNum]
                ? trainNames[+rawTrainData.TrainNum]
                : rawTrainData.RouteName,
              trainNum: `${+rawTrainData.TrainNum}`,
              trainID: `${+rawTrainData.TrainNum}-${new Date(
                stations[0].schDep
              ).getDate()}`,
              lat: property.geometry.coordinates[1],
              lon: property.geometry.coordinates[0],
              trainTimely: (
                stations.find(
                  (station) => station.code === rawTrainData.EventCode
                ) || { arrCmnt: "Unknown" }
              ).arrCmnt,
              stations: stations,
              heading: rawTrainData.Heading ? rawTrainData.Heading : "N",
              eventCode: rawTrainData.EventCode
                ? rawTrainData.EventCode
                : stations[0].code,
              eventTZ:
                stationMetaData.timeZones[
                  rawTrainData.EventCode
                    ? rawTrainData.EventCode
                    : stations[0].code
                ],
              eventName:
                stationMetaData.stationNames[
                  rawTrainData.EventCode
                    ? rawTrainData.EventCode
                    : stations[0].code
                ],
              origCode: rawTrainData.OrigCode,
              originTZ: stationMetaData.timeZones[rawTrainData.OrigCode],
              origName: stationMetaData.stationNames[rawTrainData.OrigCode],
              destCode: rawTrainData.DestCode,
              destTZ: stationMetaData.timeZones[rawTrainData.DestCode],
              destName: stationMetaData.stationNames[rawTrainData.DestCode],
              trainState: rawTrainData.TrainState,
              velocity: +rawTrainData.Velocity,
              statusMsg:
                stations.filter(
                  (station) =>
                    !station.arr &&
                    !station.dep &&
                    station.code ===
                      (rawTrainData.EventCode
                        ? rawTrainData.EventCode
                        : stations[0].code)
                ).length > 0
                  ? "SERVICE DISRUPTION"
                  : rawTrainData.StatusMsg,
              createdAt: parseDate(rawTrainData.created_at, "America/New_York")
                ? parseDate(rawTrainData.created_at, "America/New_York")
                : parseDate(rawTrainData.updated_at, "America/New_York"),
              updatedAt: parseDate(rawTrainData.updated_at, "America/New_York")
                ? parseDate(rawTrainData.updated_at, "America/New_York")
                : parseDate(rawTrainData.created_at, "America/New_York"),
              lastValTS: parseDate(
                rawTrainData.LastValTS,
                rawTrainData.EventCode
              )
                ? parseDate(rawTrainData.LastValTS, rawTrainData.EventCode)
                : stations[0].schDep,
              objectID: rawTrainData.OBJECTID,
            };

            trains[rawTrainData.TrainNum] = trains[rawTrainData.TrainNum] || [];
            trains[rawTrainData.TrainNum].push(train);

            if (train.trainState === "Active") {
              staleData.avgLastUpdate +=
                nowCleaning - new Date(train.updatedAt).valueOf();
              staleData.activeTrains++;
            }
          });

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
        })
        .catch((e) => {
          console.log("Error fetching train data:", e);
        });
    })
    .catch((e) => {
      console.log("Error fetching station data:", e);
      shitsFucked = true;
    });
};

updateTrains();

schedule.scheduleJob("*/5 * * * *", updateTrains);

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

      return new Response(JSON.stringify({
        trains,
        stations,
        ids,
        shitsFucked,
        staleData,
      }), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
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
      return new Response(shitsFucked.toString(), {
        headers: {
          "Access-Control-Allow-Origin": "*", // CORS
          "content-type": "application/json",
        },
      });
    }

    if (url === "/v3/raw") {
      return new Response(JSON.stringify(decryptedTrainData), {
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

    return new Response("Not found", {
      status: 404,
    });
  },
  tls: process.env.USE_SSL
    ? {
        key: Bun.file("/etc/letsencrypt/live/new.amtraker.com/privkey.pem"),
        cert: Bun.file("/etc/letsencrypt/live/new.amtraker.com/fullchain.pem"),
      }
    : undefined,
});
