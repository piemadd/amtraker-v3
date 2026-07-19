import {
  StationMeta,
  StationResponse,
  Train,
  TrainResponse,
} from "./types/amtraker";

export default class cache {
  trains: TrainResponse;
  stations: StationResponse;
  ids: string[];

  constructor() {
    this.trains = {};
    this.stations = {};
    this.ids = [];
    return;
  }

  getIDs() {
    return this.ids;
  }

  getTrains() {
    return this.trains;
  }

  getStation(code: string) {
    return this.stations[code];
  }

  getStations() {
    return this.stations;
  }

  setTrains(data: TrainResponse) {
    console.log("setting trains");

    let tempIDs: string[] = [];

    Object.keys(data).forEach((key) => {
      data[key].forEach((train) => {
        try {
          train.stations.forEach((station) => {
            const stationData = this.getStation(station.code);

            if (stationData && !stationData.trains.includes(train.trainID)) {
              stationData.trains.push(train.trainID);
            }

            // Only write back a real station record. Writing `undefined` here
            // would overwrite (poison) any existing cache entry for a code
            // that hasn't been populated yet by setStations().
            if (stationData) {
              this.setStation(station.code, stationData);
            }
          });

          if (!train.stations || train.stations.length === 0) {
            throw new Error(`train ${train.trainNum ?? "unknown"} has no stations`);
          }

          const trainOriginDate = new Date(train.stations[0].schDep);
          const trainOriginMonth = new Intl.DateTimeFormat([], { month: 'numeric', timeZone: train.stations[0].tz }).format(trainOriginDate);
          const trainOriginDay = new Intl.DateTimeFormat([], { day: 'numeric', timeZone: train.stations[0].tz }).format(trainOriginDate);
          const trainOriginYear = new Intl.DateTimeFormat([], { year: '2-digit', timeZone: train.stations[0].tz }).format(trainOriginDate);

          tempIDs.push(`${train.trainNum}-${trainOriginMonth}-${trainOriginDay}-${trainOriginYear}`);
        } catch (err) {
          // One malformed train (empty stations[], bad timezone string, etc.)
          // must not take down the whole cache commit. Skip its ID, keep going.
          console.log(`Failed to compute ID for a train, skipping it: ${err}`);
        }
      });
    });

    this.ids = tempIDs;
    this.trains = data;
  }

  setStation(code: string, data: StationMeta) {
    this.stations[code] = data;
  }

  setStations(data: StationResponse) {
    this.stations = data;
  }

  stationExists(code: string) {
    return this.stations[code] !== undefined && this.stations[code] !== null;
  }
}
